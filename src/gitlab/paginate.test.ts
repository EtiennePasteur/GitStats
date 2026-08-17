import { describe, it, expect } from 'vitest';
import { GitLabClient, normalizeHost, buildUrl } from './client';
import { RateLimiter } from './rateLimiter';
import { parseLinkHeader, paginate, fetchAllPages } from './paginate';

/** Fabrique un client dont le `fetch` est piloté par une fonction de test. */
function makeClient(handler: (url: URL) => { body: unknown; headers?: Record<string, string> }) {
  const calls: string[] = [];
  const limiter = new RateLimiter({ requestsPerMinute: 6_000_000, maxConcurrent: 16 });
  const client = new GitLabClient({
    host: 'https://git.example.com',
    token: 't',
    limiter,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      const { body, headers } = handler(url);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', ...headers },
      });
    }) as unknown as typeof fetch,
  });
  return { client, calls, limiter };
}

describe('normalizeHost / buildUrl', () => {
  it('accepte les formes courantes saisies par un humain', () => {
    expect(normalizeHost('gitlab.example.com')).toBe('https://gitlab.example.com');
    expect(normalizeHost('https://gitlab.example.com/')).toBe('https://gitlab.example.com');
    expect(normalizeHost('  https://gitlab.example.com/api/v4  ')).toBe(
      'https://gitlab.example.com',
    );
    expect(normalizeHost('https://host.net/gitlab')).toBe('https://host.net/gitlab');
  });

  it('rejette une saisie vide', () => {
    expect(() => normalizeHost('   ')).toThrow();
  });

  it('omet les paramètres vides et sérialise les booléens', () => {
    const url = buildUrl('https://g.net', 'projects', {
      membership: true,
      simple: true,
      search: undefined,
      ref: '',
      per_page: 100,
    });
    expect(url).toBe('https://g.net/api/v4/projects?membership=true&simple=true&per_page=100');
  });
});

describe('parseLinkHeader', () => {
  it('extrait les relations', () => {
    const header =
      '<https://g/api/v4/projects?page=2>; rel="next", <https://g/api/v4/projects?page=1>; rel="first"';
    expect(parseLinkHeader(header)).toEqual({
      next: 'https://g/api/v4/projects?page=2',
      first: 'https://g/api/v4/projects?page=1',
    });
  });

  it('renvoie un objet vide sans header', () => {
    expect(parseLinkHeader(null)).toEqual({});
  });
});

describe('paginate', () => {
  it("s'arrête sur X-Next-Page vide sans requête superflue", async () => {
    const { client, calls } = makeClient((url) => {
      const page = Number(url.searchParams.get('page'));
      return {
        body: Array.from({ length: 100 }, (_, i) => ({ id: (page - 1) * 100 + i })),
        headers: {
          'x-next-page': page < 3 ? String(page + 1) : '',
          'x-total-pages': '3',
          'x-total': '300',
        },
      };
    });

    const items = await fetchAllPages<{ id: number }>(client, 'projects');
    expect(items).toHaveLength(300);
    // Exactement 3 appels : la 3ᵉ page est pleine (100 items) mais X-Next-Page
    // est vide, donc aucune 4ᵉ requête à vide.
    expect(calls).toHaveLength(3);
  });

  it('expose totalPages dès la première page pour une progression exacte', async () => {
    const { client } = makeClient((url) => {
      const page = Number(url.searchParams.get('page'));
      return {
        body: Array.from({ length: page < 3 ? 100 : 34 }, (_, i) => ({ id: i })),
        headers: { 'x-next-page': page < 3 ? String(page + 1) : '', 'x-total-pages': '3', 'x-total': '234' },
      };
    });

    const seen: Array<number | undefined> = [];
    for await (const page of paginate<{ id: number }>(client, 'projects')) {
      seen.push(page.totalPages);
      if (page.page === 1) expect(page.total).toBe(234);
    }
    expect(seen).toEqual([3, 3, 3]);
  });

  it("gère l'API commits qui ne renvoie ni X-Total ni X-Total-Pages", async () => {
    const { client, calls } = makeClient((url) => {
      const page = Number(url.searchParams.get('page'));
      return {
        body: Array.from({ length: page < 2 ? 100 : 20 }, (_, i) => ({ id: `c${page}-${i}` })),
        headers: {
          // Ce que renvoie réellement l'endpoint commits : Link + X-Next-Page,
          // mais aucun compteur total.
          link:
            page < 2
              ? '<https://g/api/v4/projects/1/repository/commits?page=2>; rel="next"'
              : '<https://g/api/v4/projects/1/repository/commits?page=1>; rel="first"',
          'x-next-page': page < 2 ? '2' : '',
        },
      };
    });

    const pages: Array<{ count: number; totalPages: number | undefined }> = [];
    for await (const page of paginate<{ id: string }>(client, 'projects/1/repository/commits')) {
      pages.push({ count: page.items.length, totalPages: page.totalPages });
    }
    expect(pages).toEqual([
      { count: 100, totalPages: undefined },
      { count: 20, totalPages: undefined },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('se rabat sur la taille de page si aucun header de pagination nʼest lisible', async () => {
    const { client, calls } = makeClient((url) => {
      const page = Number(url.searchParams.get('page'));
      // Aucun header : cas d'un proxy filtrant.
      return { body: page < 2 ? Array.from({ length: 100 }, (_, i) => ({ id: i })) : [] };
    });

    const items = await fetchAllPages<{ id: number }>(client, 'projects');
    expect(items).toHaveLength(100);
    expect(calls).toHaveLength(2); // le repli coûte un appel à vide, assumé
  });

  it('plafonne per_page à 100 (limite GitLab)', async () => {
    const { client, calls } = makeClient(() => ({ body: [], headers: { 'x-next-page': '' } }));
    await fetchAllPages(client, 'projects', {}, { perPage: 500 });
    expect(calls[0]).toContain('per_page=100');
  });

  it('respecte maxPages', async () => {
    const { client, calls } = makeClient((url) => {
      const page = Number(url.searchParams.get('page'));
      return {
        body: Array.from({ length: 100 }, (_, i) => ({ id: i })),
        headers: { 'x-next-page': String(page + 1) },
      };
    });
    await fetchAllPages(client, 'projects', {}, { maxPages: 4 });
    expect(calls).toHaveLength(4);
  });
});
