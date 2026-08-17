/**
 * Client REST GitLab v4, sans dépendance framework (utilisable en Web Worker).
 *
 * Responsabilités : construction d'URL, authentification, passage par
 * l'ordonnanceur, retry avec backoff exponentiel + full jitter, et traduction
 * des statuts HTTP en erreurs typées.
 */

import { RateLimiter, AbortError } from './rateLimiter';
import {
  GitLabError,
  GitLabAuthError,
  GitLabForbiddenError,
  GitLabNotFoundError,
  GitLabNetworkError,
  GitLabRetryExhaustedError,
} from './errors';

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface GitLabResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

export interface GitLabClientOptions {
  /** Racine de l'instance, ex. `https://gitlab.example.com`. */
  host: string;
  token: string;
  limiter: RateLimiter;
  /** Nombre de tentatives par requête (la 1ʳᵉ incluse). */
  maxAttempts?: number;
  /** Délai de base du backoff. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Timeout par tentative. */
  timeoutMs?: number;
  /** Injectable pour les tests. */
  fetchImpl?: typeof fetch;
}

/** Normalise `git.example.com`, `https://git.example.com/`, `.../api/v4` → racine propre. */
export function normalizeHost(rawHost: string): string {
  let host = rawHost.trim();
  if (host === '') throw new Error("L'URL de l'instance GitLab est vide.");
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`URL d'instance GitLab invalide : ${rawHost}`);
  }
  // On tolère que l'utilisateur colle une URL contenant déjà /api/v4.
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v4$/, '');
  return `${url.origin}${path}`;
}

export function buildUrl(host: string, path: string, params?: QueryParams): string {
  const base = `${normalizeHost(host)}/api/v4/${path.replace(/^\/+/, '')}`;
  const url = new URL(base);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Backoff exponentiel avec full jitter (AWS) : évite que les retries se resynchronisent. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.random() * ceiling;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof AbortError ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export class GitLabClient {
  readonly host: string;
  private readonly token: string;
  private readonly limiter: RateLimiter;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitLabClientOptions) {
    this.host = normalizeHost(options.host);
    this.token = options.token.trim();
    this.limiter = options.limiter;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 2_000;
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async get<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<GitLabResponse<T>> {
    const url = buildUrl(this.host, path, params);
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.limiter.run(() => this.fetchOnce<T>(url, signal), signal);
      } catch (error) {
        lastError = error;
        if (isAbort(error)) throw error;

        // Erreurs définitives : inutile d'insister.
        if (
          error instanceof GitLabAuthError ||
          error instanceof GitLabForbiddenError ||
          error instanceof GitLabNotFoundError
        ) {
          throw error;
        }
        // 4xx autres que 429 : la requête est mal formée, retenter ne changera rien.
        if (error instanceof GitLabError && error.status >= 400 && error.status < 500 && error.status !== 429) {
          throw error;
        }
        if (attempt === this.maxAttempts) break;
        await sleep(backoffDelay(attempt, this.retryBaseMs, this.retryMaxMs), signal);
      }
    }
    throw new GitLabRetryExhaustedError(url, this.maxAttempts, lastError);
  }

  private async fetchOnce<T>(url: string, signal?: AbortSignal): Promise<GitLabResponse<T>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'PRIVATE-TOKEN': this.token,
          Accept: 'application/json',
        },
        signal: combined,
        // Pas de cookies : l'API répond `Access-Control-Allow-Origin: *`, qui est
        // incompatible avec les requêtes créditées.
        credentials: 'omit',
        mode: 'cors',
      });
    } catch (error) {
      if (signal?.aborted) throw new AbortError();
      if (timeout.aborted) throw new GitLabError(`Timeout après ${this.timeoutMs} ms`, 0, url);
      throw new GitLabNetworkError(url, error);
    }

    if (response.ok) {
      this.limiter.reportSuccess();
      const data = (await response.json()) as T;
      return { data, headers: response.headers, status: response.status };
    }

    const body = await response.text().catch(() => undefined);

    switch (response.status) {
      case 401:
        throw new GitLabAuthError(url, body);
      case 403:
        throw new GitLabForbiddenError(url, body);
      case 404:
        throw new GitLabNotFoundError(url, body);
      case 429:
        // Le seul signal de saturation exploitable depuis le navigateur.
        this.limiter.penalize();
        throw new GitLabError('Débit limité par GitLab (429).', 429, url, body);
      default:
        if (response.status >= 500) this.limiter.penalize();
        throw new GitLabError(
          `GitLab a répondu ${response.status} ${response.statusText}`,
          response.status,
          url,
          body,
        );
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
