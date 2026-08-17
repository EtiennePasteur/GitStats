/**
 * Pagination offset générique.
 *
 * Les headers utiles (`Link`, `X-Total`, `X-Total-Pages`, `X-Next-Page`) sont bien
 * dans `Access-Control-Expose-Headers` de GitLab, donc lisibles depuis le navigateur.
 *
 * Nuance importante : l'API commits ne renvoie NI `X-Total` NI `X-Total-Pages`
 * (choix de perf côté GitLab). On ne peut donc pas connaître le nombre de pages
 * à l'avance sur ce endpoint — d'où la triple condition d'arrêt ci-dessous.
 */

import type { GitLabClient, QueryParams } from './client';

export interface Page<T> {
  items: T[];
  /** Numéro de la page qui vient d'être lue (1-indexé). */
  page: number;
  /** Absent sur l'API commits, et au-delà de 10 000 enregistrements. */
  totalPages: number | undefined;
  total: number | undefined;
  hasMore: boolean;
}

export interface PaginateOptions {
  perPage?: number;
  signal?: AbortSignal;
  /** Garde-fou anti-boucle infinie. */
  maxPages?: number;
}

/** `<url>; rel="next", <url>; rel="last"` → { next: url, last: url } */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?([^"\s;]+)"?/.exec(part.trim());
    if (match?.[1] && match[2]) links[match[2]] = match[1];
  }
  return links;
}

function parseIntHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Itère les pages une par une : l'appelant peut traiter et afficher au fil de l'eau. */
export async function* paginate<T>(
  client: GitLabClient,
  path: string,
  params: QueryParams = {},
  options: PaginateOptions = {},
): AsyncGenerator<Page<T>, void, undefined> {
  const perPage = Math.min(100, Math.max(1, options.perPage ?? 100)); // 100 = plafond GitLab
  const maxPages = options.maxPages ?? 1_000;
  let page = 1;

  while (page <= maxPages) {
    const response = await client.get<T[]>(
      path,
      { ...params, page, per_page: perPage },
      options.signal,
    );
    const items = Array.isArray(response.data) ? response.data : [];
    const totalPages = parseIntHeader(response.headers, 'x-total-pages');
    const total = parseIntHeader(response.headers, 'x-total');

    // Arrêt piloté par les headers quand ils sont exploitables, sinon repli sur
    // la taille de page. Les deux ne doivent PAS être combinés en OR : une
    // dernière page exactement pleine ferait alors une requête inutile à chaque
    // dépôt (≈234 appels gaspillés par sync).
    const nextPageHeader = response.headers.get('x-next-page');
    const linkHeader = response.headers.get('link');
    const links = parseLinkHeader(linkHeader);
    const headersAreInformative = nextPageHeader !== null || linkHeader !== null;

    let hasMore: boolean;
    if (items.length === 0) {
      hasMore = false;
    } else if (headersAreInformative) {
      hasMore = (nextPageHeader?.trim() ?? '') !== '' || links['next'] !== undefined;
    } else {
      // Aucun header lisible (proxy filtrant, endpoint exotique) : on continue
      // tant que les pages sont pleines, au prix d'un appel final à vide.
      hasMore = items.length === perPage;
    }

    yield { items, page, totalPages, total, hasMore };

    if (!hasMore) return;
    page += 1;
  }
}

/** Variante « tout d'un coup » pour les collections dont on sait qu'elles sont petites. */
export async function fetchAllPages<T>(
  client: GitLabClient,
  path: string,
  params: QueryParams = {},
  options: PaginateOptions = {},
): Promise<T[]> {
  const all: T[] = [];
  for await (const page of paginate<T>(client, path, params, options)) {
    all.push(...page.items);
  }
  return all;
}
