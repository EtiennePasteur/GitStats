import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitLabClient, backoffDelay } from './client';
import { RateLimiter } from './rateLimiter';
import {
  GitLabAuthError,
  GitLabForbiddenError,
  GitLabNotFoundError,
  GitLabNetworkError,
  GitLabRetryExhaustedError,
} from './errors';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Client dont chaque appel consomme la réponse suivante de la liste. */
function makeClient(responses: Array<Response | (() => Response | never)>) {
  const limiter = new RateLimiter({ requestsPerMinute: 6_000_000, maxConcurrent: 16 });
  let index = 0;
  const client = new GitLabClient({
    host: 'https://git.example.com',
    token: 'glpat-test',
    limiter,
    retryBaseMs: 1_000,
    retryMaxMs: 4_000,
    fetchImpl: (async () => {
      const entry = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (typeof entry === 'function') return entry();
      return entry!.clone();
    }) as unknown as typeof fetch,
  });
  return { client, limiter, callCount: () => index };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('GitLabClient — en-têtes et succès', () => {
  it("envoie le token en PRIVATE-TOKEN et n'envoie pas de cookies", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 6_000_000, maxConcurrent: 4 });
    let seen: RequestInit | undefined;
    const client = new GitLabClient({
      host: 'git.example.com',
      token: 'glpat-abc',
      limiter,
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        seen = init;
        return json({ id: 1, username: 'ariviere' });
      }) as unknown as typeof fetch,
    });

    const res = await client.get<{ username: string }>('user');
    expect(res.data.username).toBe('ariviere');
    expect((seen?.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('glpat-abc');
    // `Access-Control-Allow-Origin: *` interdit les requêtes créditées : envoyer
    // des cookies ferait échouer le CORS.
    expect(seen?.credentials).toBe('omit');
  });
});

describe('GitLabClient — erreurs définitives (aucun retry)', () => {
  it('401 → GitLabAuthError en une seule tentative', async () => {
    const { client, callCount } = makeClient([json({ message: '401 Unauthorized' }, 401)]);
    const p = client.get('user').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toBeInstanceOf(GitLabAuthError);
    expect(callCount()).toBe(1);
  });

  it('403 → GitLabForbiddenError en une seule tentative', async () => {
    const { client, callCount } = makeClient([json({ message: '403 Forbidden' }, 403)]);
    const p = client.get('projects/1/repository/commits').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toBeInstanceOf(GitLabForbiddenError);
    expect(callCount()).toBe(1);
  });

  it('404 → GitLabNotFoundError (cas normal du dépôt vide)', async () => {
    const { client, callCount } = makeClient([json({ message: '404 Not Found' }, 404)]);
    const p = client.get('projects/1/repository/contributors').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toBeInstanceOf(GitLabNotFoundError);
    expect(callCount()).toBe(1);
  });
});

describe('GitLabClient — retry', () => {
  it('retente après un 429 et pénalise le limiteur', async () => {
    const { client, limiter, callCount } = makeClient([
      json({ message: 'rate limited' }, 429),
      json([{ id: 1 }]),
    ]);
    const before = limiter.stats().currentRpm;

    const p = client.get<Array<{ id: number }>>('projects');
    await vi.advanceTimersByTimeAsync(10_000);

    const res = await p;
    expect(res.data).toEqual([{ id: 1 }]);
    expect(callCount()).toBe(2);
    // Le 429 est le seul signal de saturation lisible : il doit brider le débit.
    expect(limiter.stats().currentRpm).toBeLessThan(before);
    expect(limiter.stats().penalties).toBe(1);
  });

  it('retente après un 500 puis réussit', async () => {
    const { client, callCount } = makeClient([
      json({ message: 'oops' }, 500),
      json({ message: 'oops' }, 502),
      json([{ id: 7 }]),
    ]);
    const p = client.get<Array<{ id: number }>>('projects');
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await p).data).toEqual([{ id: 7 }]);
    expect(callCount()).toBe(3);
  });

  it('abandonne après maxAttempts avec une erreur explicite', async () => {
    const { client, callCount } = makeClient([json({ message: 'down' }, 503)]);
    const p = client.get('projects').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(300_000);
    const error = await p;
    expect(error).toBeInstanceOf(GitLabRetryExhaustedError);
    expect(callCount()).toBe(5); // maxAttempts par défaut
  });

  it('traduit un échec réseau/CORS en message actionnable', async () => {
    const { client } = makeClient([
      () => {
        throw new TypeError('Failed to fetch');
      },
    ]);
    const p = client.get('projects').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(300_000);
    const error = await p;
    expect(error).toBeInstanceOf(GitLabRetryExhaustedError);
    expect((error as Error).cause).toBeInstanceOf(GitLabNetworkError);
    expect(((error as Error).cause as Error).message).toContain('CORS');
  });
});

describe('backoffDelay', () => {
  it('croît exponentiellement et reste sous le plafond', () => {
    const samples = (attempt: number) =>
      Array.from({ length: 200 }, () => backoffDelay(attempt, 2_000, 60_000));

    for (const value of samples(1)) expect(value).toBeLessThanOrEqual(2_000);
    for (const value of samples(3)) expect(value).toBeLessThanOrEqual(8_000);
    for (const value of samples(10)) expect(value).toBeLessThanOrEqual(60_000);
    for (const value of samples(1)) expect(value).toBeGreaterThanOrEqual(0);

    // Full jitter : les délais doivent être dispersés, pas constants, sinon tous
    // les retries repartent en même temps.
    const spread = new Set(samples(5).map((v) => Math.round(v / 100)));
    expect(spread.size).toBeGreaterThan(10);
  });
});
