import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { SyncCoordinator, type AggregateProgress } from './coordinator';
import { DEFAULT_SYNC_CONFIG, type SyncConfig, type GitLabInstance } from '../model/types';
import { loadDataset, type Dataset } from '../store/dataset';
import { deleteDatabase, closeDb, readMeta, writeMeta } from '../store/db';
import type { GitLabCommit, GitLabContributor, GitLabProjectSimple } from '../gitlab/types';
import { sumHours } from '../model/hours';

/**
 * Instance GitLab simulée : projets, contributeurs, commits, pagination et
 * headers conformes à ce que renvoie réellement l'API (notamment l'absence de
 * `X-Total-Pages` sur les commits).
 */
class FakeGitLab {
  calls: string[] = [];
  projects: GitLabProjectSimple[] = [];
  commitsByProject = new Map<number, GitLabCommit[]>();
  contributorsByProject = new Map<number, GitLabContributor[]>();

  constructor(projectCount: number, commitsPerProject: number) {
    for (let i = 1; i <= projectCount; i++) {
      this.projects.push({
        id: i,
        name: `projet-${i}`,
        path_with_namespace: `groupe/projet-${i}`,
        name_with_namespace: `Groupe / projet-${i}`,
        default_branch: 'main',
        web_url: `https://git/groupe/projet-${i}`,
        avatar_url: null,
        last_activity_at: '2026-08-10T09:00:00.000Z',
        created_at: '2024-01-01T00:00:00.000Z',
        namespace: { id: 1, name: 'Groupe', path: 'groupe', full_path: 'groupe', kind: 'group' },
      });
      this.contributorsByProject.set(i, [
        { name: 'Amélie Rivière', email: 'a.riviere@example.com', commits: 10, additions: 100, deletions: 20 },
      ]);
      this.commitsByProject.set(
        i,
        Array.from({ length: commitsPerProject }, (_, k) => this.makeCommit(i, k, '2026-08-0'.concat(String((k % 9) + 1)))),
      );
    }
  }

  makeCommit(projectId: number, index: number, day: string): GitLabCommit {
    const date = `${day}T10:00:00.000+02:00`;
    return {
      id: `p${projectId}-c${index}`,
      short_id: `p${projectId}c${index}`,
      title: `commit ${index}`,
      author_name: index % 3 === 0 ? 'Marie Durand' : 'Amélie Rivière',
      author_email: index % 3 === 0 ? 'm.durand@example.com' : 'a.riviere@example.com',
      authored_date: date,
      committer_name: 'x',
      committer_email: 'x@example.com',
      committed_date: date,
      parent_ids: ['parent'],
      web_url: `https://git/commit/${index}`,
      stats: { additions: 10, deletions: 4, total: 14 },
    };
  }

  /** Ajoute un commit tout frais et fait bouger `last_activity_at`. */
  push(projectId: number, at: string): void {
    const commits = this.commitsByProject.get(projectId)!;
    commits.unshift(this.makeCommit(projectId, 9_000 + commits.length, at.slice(0, 10)));
    const project = this.projects.find((p) => p.id === projectId)!;
    project.last_activity_at = at;
  }

  readonly fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    this.calls.push(url.pathname + url.search);
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '100');

    const paged = <T>(items: T[], extraHeaders: Record<string, string> = {}) => {
      const slice = items.slice((page - 1) * perPage, page * perPage);
      const hasNext = page * perPage < items.length;
      return new Response(JSON.stringify(slice), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-next-page': hasNext ? String(page + 1) : '',
          ...extraHeaders,
        },
      });
    };

    if (url.pathname.endsWith('/api/v4/projects')) {
      return paged(this.projects, {
        'x-total': String(this.projects.length),
        'x-total-pages': String(Math.ceil(this.projects.length / perPage)),
      });
    }

    const contributorsMatch = /\/api\/v4\/projects\/(\d+)\/repository\/contributors$/.exec(url.pathname);
    if (contributorsMatch) {
      const id = Number(contributorsMatch[1]);
      return paged(this.contributorsByProject.get(id) ?? []);
    }

    const commitsMatch = /\/api\/v4\/projects\/(\d+)\/repository\/commits$/.exec(url.pathname);
    if (commitsMatch) {
      const id = Number(commitsMatch[1]);
      const since = url.searchParams.get('since');
      const until = url.searchParams.get('until');
      const withStats = url.searchParams.get('with_stats') === 'true';
      const all = (this.commitsByProject.get(id) ?? [])
        .filter((commit) => {
          const at = new Date(commit.committed_date).toISOString();
          if (since !== null && at < new Date(since).toISOString()) return false;
          if (until !== null && at > new Date(until).toISOString()) return false;
          return true;
        })
        // Comme la vraie API : sans `with_stats`, le champ `stats` est absent.
        .map((commit) => (withStats ? commit : { ...commit, stats: undefined }));
      // L'API commits ne renvoie NI x-total NI x-total-pages : on reproduit ce
      // comportement pour vérifier que la pagination ne s'appuie pas dessus.
      return paged(all);
    }

    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

function instance(id: string, host: string): GitLabInstance {
  return { id, host, label: id, user: null, addedAt: '2026-01-01T00:00:00.000Z', authError: null };
}

const INSTANCE_A = instance('inst-a', 'https://git-a.example.com');

/**
 * Construit un coordinateur. `fetchImpl` est injecté par instance, ce qui permet
 * de simuler plusieurs serveurs distincts dans un même test.
 */
function makeSync(
  targets: Array<{ instance: GitLabInstance; fake: FakeGitLab }>,
  dataset: Dataset,
  config: SyncConfig,
  now: Date,
) {
  // Reprise quasi instantanée : le backoff réel (jusqu'à 30 s cumulées) est
  // couvert par `client.test.ts`, pas ici.
  const retry = { maxAttempts: 2, baseMs: 1, maxMs: 2 };
  const captured: { value: AggregateProgress | null } = { value: null };
  const coordinator = new SyncCoordinator({
    targets: targets.map(({ instance: inst, fake }) => ({
      instance: inst,
      token: 'glpat-test',
      fetchImpl: fake.fetch as unknown as typeof fetch,
      retry,
    })),
    config,
    dataset,
    onProgress: (progress) => {
      captured.value = progress;
    },
    onDataChanged: () => {},
    now: () => now,
  });
  // `run()` enveloppé pour libérer les limiteurs : leurs timers survivraient
  // sinon au test et fausseraient les suivants.
  const run = async () => {
    try {
      await coordinator.run();
    } finally {
      coordinator.dispose();
    }
  };
  return { coordinator, run, progress: () => captured.value };
}

/** Raccourci mono-instance, pour les tests hérités. */
function makeEngine(fake: FakeGitLab, dataset: Dataset, config: SyncConfig, now: Date) {
  const { coordinator, run, progress } = makeSync([{ instance: INSTANCE_A, fake }], dataset, config, now);
  return { engine: { run, cancel: () => coordinator.cancel() }, progress };
}

const CONFIG: SyncConfig = {
  ...DEFAULT_SYNC_CONFIG,
  windowMonths: 12,
  maxConcurrent: 8,
  // Débit volontairement déplafonné : le limiteur est testé pour lui-même dans
  // `rateLimiter.test.ts`. Ici on mesure la logique de collecte, pas l'attente —
  // 101 appels à 400/min mettraient 15 secondes.
  requestsPerMinute: 6_000_000,
};

beforeEach(async () => {
  await deleteDatabase();
});

describe('SyncEngine — collecte initiale', () => {
  it('découvre, agrège et persiste', async () => {
    const fake = new FakeGitLab(5, 150); // 2 pages de commits par projet
    const dataset = await loadDataset();
    const { engine, progress } = makeEngine(fake, dataset, CONFIG, new Date('2026-08-17T12:00:00.000Z'));

    await engine.run();

    expect(progress()?.phase).toBe('done');
    expect(progress()?.projectsDone).toBe(5);
    expect(progress()?.commitsIngested).toBe(750);

    // Les seaux sont bien ventilés par (projet, auteur, jour).
    expect(dataset.daily.size).toBeGreaterThan(0);
    const totalCommits = [...dataset.daily.values()].reduce((sum, b) => sum + b.commits, 0);
    expect(totalCommits).toBe(750);

    // Deux auteurs distincts, additions/deletions bien remontées.
    expect(dataset.authors.size).toBe(2);
    const totalAdditions = [...dataset.daily.values()].reduce((sum, b) => sum + b.additions, 0);
    expect(totalAdditions).toBe(750 * 10);

    // Les heures sont portées par les seaux, pas par un magasin à part.
    const knownHours = [...dataset.daily.values()].reduce((sum, b) => sum + sumHours(b.hourly), 0);
    expect(knownHours).toBe(750);

    // Les données survivent à un rechargement de page.
    const reloaded = await loadDataset();
    expect(reloaded.projects.size).toBe(5);
    expect([...reloaded.daily.values()].reduce((sum, b) => sum + b.commits, 0)).toBe(750);
    // Mémoire et IndexedDB fusionnent par deux chemins distincts : s'ils
    // divergeaient, les chiffres changeraient au simple rechargement de l'onglet.
    expect([...reloaded.daily.values()].reduce((sum, b) => sum + sumHours(b.hourly), 0)).toBe(knownHours);
  });

  it('compte le bon nombre d\'appels : 1 liste + 1 aperçu/projet + pages de commits', async () => {
    const fake = new FakeGitLab(5, 150);
    const dataset = await loadDataset();
    const { engine } = makeEngine(fake, dataset, CONFIG, new Date('2026-08-17T12:00:00.000Z'));
    await engine.run();

    const listCalls = fake.calls.filter((c) => c.includes('/projects?')).length;
    const overviewCalls = fake.calls.filter((c) => c.includes('/contributors')).length;
    const commitCalls = fake.calls.filter((c) => c.includes('/commits')).length;

    expect(listCalls).toBe(1);
    expect(overviewCalls).toBe(5);
    expect(commitCalls).toBe(10); // 150 commits = 2 pages, sans page finale à vide
    expect(fake.calls).toHaveLength(16);
  });
});

describe('SyncEngine — incrémental (le point critique)', () => {
  it('ne refait AUCUN appel projet quand rien n\'a bougé', async () => {
    const fake = new FakeGitLab(50, 40);
    const now = new Date('2026-08-17T12:00:00.000Z');

    const first = await loadDataset();
    await makeEngine(fake, first, CONFIG, now).engine.run();
    const firstRunCalls = fake.calls.length;
    expect(firstRunCalls).toBe(1 + 50 + 50); // liste + aperçus + 1 page de commits

    // Rechargement de page, puis relance immédiate.
    fake.calls = [];
    await closeDb();
    const second = await loadDataset();
    const { engine, progress } = makeEngine(fake, second, CONFIG, now);
    await engine.run();

    expect(progress()?.projectsSkipped).toBe(50);
    expect(progress()?.projectsDone).toBe(0);
    // Seule la liste des projets est redemandée : 1 appel au total.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toContain('/projects?');
  });

  it('ne resynchronise que les dépôts réellement actifs', async () => {
    const fake = new FakeGitLab(50, 40);
    const now = new Date('2026-08-17T12:00:00.000Z');

    const first = await loadDataset();
    await makeEngine(fake, first, CONFIG, now).engine.run();
    const before = [...first.daily.values()].reduce((sum, b) => sum + b.commits, 0);

    // 3 dépôts reçoivent un nouveau commit.
    fake.push(1, '2026-08-17T08:00:00.000Z');
    fake.push(2, '2026-08-17T08:30:00.000Z');
    fake.push(3, '2026-08-17T09:00:00.000Z');

    fake.calls = [];
    await closeDb();
    const second = await loadDataset();
    const { engine, progress } = makeEngine(fake, second, CONFIG, new Date('2026-08-17T12:00:00.000Z'));
    await engine.run();

    expect(progress()?.projectsDone).toBe(3);
    expect(progress()?.projectsSkipped).toBe(47);
    // 1 liste + 3 pages de commits, et surtout AUCUN aperçu redemandé.
    expect(fake.calls.filter((c) => c.includes('/contributors'))).toHaveLength(0);
    expect(fake.calls).toHaveLength(4);

    const after = [...second.daily.values()].reduce((sum, b) => sum + b.commits, 0);
    expect(after).toBe(before + 3);
  });

  it('ne compte pas deux fois les commits de la zone de recouvrement', async () => {
    const fake = new FakeGitLab(3, 20);
    const now = new Date('2026-08-17T12:00:00.000Z');

    const first = await loadDataset();
    await makeEngine(fake, first, CONFIG, now).engine.run();
    const before = [...first.daily.values()].reduce((sum, b) => sum + b.commits, 0);
    expect(before).toBe(60);

    // Le dépôt bouge : le sync incrémental repart 1 h avant la borne couverte et
    // va donc forcément re-télécharger des commits déjà comptés.
    fake.push(1, '2026-08-17T11:30:00.000Z');

    await closeDb();
    const second = await loadDataset();
    await makeEngine(fake, second, CONFIG, new Date('2026-08-17T12:00:00.000Z')).engine.run();

    const after = [...second.daily.values()].reduce((sum, b) => sum + b.commits, 0);
    expect(after).toBe(61); // +1 exactement, pas de doublon
  });

  it('rattrape les commits anciens arrivés par un merge de branche', async () => {
    const fake = new FakeGitLab(2, 10);
    const now = new Date('2026-08-17T12:00:00.000Z');

    const first = await loadDataset();
    await makeEngine(fake, first, CONFIG, now).engine.run();
    const before = [...first.daily.values()].reduce((sum, b) => sum + b.commits, 0);

    // Une branche vieille de 3 jours est mergée : les commits entrent dans le
    // dépôt maintenant, mais leur date de commit est antérieure au dernier sync.
    // Avec un recouvrement d'une heure, ils seraient perdus définitivement.
    const commits = fake.commitsByProject.get(1)!;
    commits.unshift(fake.makeCommit(1, 8_001, '2026-08-14'));
    commits.unshift(fake.makeCommit(1, 8_002, '2026-08-15'));
    fake.projects[0]!.last_activity_at = '2026-08-17T11:00:00.000Z';

    await closeDb();
    const second = await loadDataset();
    await makeEngine(fake, second, CONFIG, new Date('2026-08-17T12:00:00.000Z')).engine.run();

    const after = [...second.daily.values()].reduce((sum, b) => sum + b.commits, 0);
    expect(after).toBe(before + 2);
  });

  it('ne va chercher que le trou quand la fenêtre est élargie', async () => {
    const fake = new FakeGitLab(4, 10);
    const now = new Date('2026-08-17T12:00:00.000Z');

    const first = await loadDataset();
    await makeEngine(fake, first, CONFIG, now).engine.run();

    fake.calls = [];
    await closeDb();
    const second = await loadDataset();
    await makeEngine(fake, second, { ...CONFIG, windowMonths: 24 }, now).engine.run();

    const commitCalls = fake.calls.filter((c) => c.includes('/commits'));
    expect(commitCalls).toHaveLength(4);
    // La borne haute de la requête de rattrapage s'arrête là où la couverture
    // commençait : on ne retélécharge pas les 12 mois déjà connus.
    for (const call of commitCalls) {
      expect(call).toContain('until=2025-08-17');
      expect(call).toContain('since=2024-08-17');
    }
  });

  it('repart de zéro si les options de collecte changent', async () => {
    const fake = new FakeGitLab(3, 10);
    const now = new Date('2026-08-17T12:00:00.000Z');

    const first = await loadDataset();
    await makeEngine(fake, first, { ...CONFIG, withStats: false }, now).engine.run();
    // Sans with_stats, aucune ligne n'est comptée.
    expect([...first.daily.values()].reduce((sum, b) => sum + b.additions, 0)).toBe(0);

    fake.calls = [];
    await closeDb();
    const second = await loadDataset();
    await makeEngine(fake, second, { ...CONFIG, withStats: true }, now).engine.run();

    // Les seaux à 0 ligne ont été purgés et remplacés, pas additionnés.
    const commits = [...second.daily.values()].reduce((sum, b) => sum + b.commits, 0);
    expect(commits).toBe(30);
    expect([...second.daily.values()].reduce((sum, b) => sum + b.additions, 0)).toBe(300);
  });
});

describe('SyncEngine — robustesse', () => {
  it('isole une erreur projet sans faire échouer le sync', async () => {
    const fake = new FakeGitLab(4, 10);
    const original = fake.fetch;
    // Le dépôt 2 renvoie systématiquement 500 sur ses commits.
    const failing = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/projects/2/repository/commits')) {
        return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      }
      return original(input);
    }) as unknown as typeof fetch;

    const dataset = await loadDataset();
    const { run, progress } = makeSync(
      [{ instance: INSTANCE_A, fake: { ...fake, fetch: failing } as unknown as FakeGitLab }],
      dataset,
      { ...CONFIG, maxConcurrent: 8 },
      new Date('2026-08-17T12:00:00.000Z'),
    );
    await run();

    expect(progress()?.phase).toBe('done');
    expect(progress()?.projectsError).toBe(1);
    expect(progress()?.projectsDone).toBe(3);
    // Les 3 autres dépôts sont bien allés au bout.
    expect([...dataset.daily.values()].reduce((sum, b) => sum + b.commits, 0)).toBe(30);
  });

  it('traite un dépôt vide (404) comme vide, pas comme une erreur', async () => {
    const fake = new FakeGitLab(2, 10);
    const original = fake.fetch;
    const withEmpty = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/projects/2/repository/')) {
        return new Response(JSON.stringify({ message: '404 Not Found' }), { status: 404 });
      }
      return original(input);
    }) as unknown as typeof fetch;

    const dataset = await loadDataset();
    const { run, progress } = makeSync(
      [{ instance: INSTANCE_A, fake: { ...fake, fetch: withEmpty } as unknown as FakeGitLab }],
      dataset,
      CONFIG,
      new Date('2026-08-17T12:00:00.000Z'),
    );
    await run();

    expect(progress()?.phase).toBe('done');
    expect(progress()?.projectsError).toBe(0);
    expect(dataset.projects.get('inst-a~2')?.sync.state).toBe('empty');
  });

  it('conserve les données déjà collectées après une annulation', async () => {
    const fake = new FakeGitLab(30, 20);
    const dataset = await loadDataset();
    const { engine, progress } = makeEngine(fake, dataset, CONFIG, new Date('2026-08-17T12:00:00.000Z'));

    const running = engine.run();
    setTimeout(() => engine.cancel(), 5);
    await running;

    expect(progress()?.phase).toBe('cancelled');
    await closeDb();
    const reloaded = await loadDataset();
    // On ne perd pas ce qui avait été ingéré avant l'interruption.
    expect(reloaded.projects.size).toBe(30);
  });

  it('conserve les fusions manuelles au fil des syncs', async () => {
    const fake = new FakeGitLab(2, 9);
    const now = new Date('2026-08-17T12:00:00.000Z');
    const dataset = await loadDataset();
    await makeEngine(fake, dataset, CONFIG, now).engine.run();
    expect(dataset.authors.size).toBe(2);

    // L'utilisateur déclare que Marie et Étienne sont la même personne.
    const meta = (await readMeta()) ?? {
      schemaVersion: 2,
      instances: [INSTANCE_A],
      window: null,
      lastSyncAt: null,
      config: CONFIG,
      manualAliases: {},
    };
    meta.manualAliases = { 'm.durand@example.com': 'a.riviere@example.com' };
    await writeMeta(meta);

    fake.push(1, '2026-08-17T11:00:00.000Z');
    await closeDb();
    const second = await loadDataset();
    await makeEngine(fake, second, CONFIG, new Date('2026-08-17T12:00:00.000Z')).engine.run();

    expect(second.authors.size).toBe(1);
    expect([...second.authors.keys()]).toEqual(['a.riviere@example.com']);
  });
});

describe('SyncCoordinator — plusieurs instances', () => {
  const INSTANCE_B = instance('inst-b', 'https://git-b.example.com');
  const NOW = new Date('2026-08-17T12:00:00.000Z');

  /** Deux serveurs dont les identifiants de projet se recouvrent VOLONTAIREMENT. */
  function twoInstances(projectCount = 5, commitsPer = 20) {
    const a = new FakeGitLab(projectCount, commitsPer);
    const b = new FakeGitLab(projectCount, commitsPer);
    // Des noms distincts pour vérifier qu'aucun ne masque l'autre.
    for (const project of b.projects) project.name = `b-${project.name}`;
    return { a, b };
  }

  it('ne confond pas deux projets portant le même identifiant numérique', async () => {
    const { a, b } = twoInstances(5, 20);
    const dataset = await loadDataset();
    const { run, progress } = makeSync(
      [
        { instance: INSTANCE_A, fake: a },
        { instance: INSTANCE_B, fake: b },
      ],
      dataset,
      CONFIG,
      NOW,
    );
    await run();

    // 5 projets de chaque côté, aucun écrasement : c'est tout l'enjeu de la clé
    // préfixée par l'instance.
    expect(dataset.projects.size).toBe(10);
    expect([...dataset.projects.keys()].sort()).toEqual([
      'inst-a~1', 'inst-a~2', 'inst-a~3', 'inst-a~4', 'inst-a~5',
      'inst-b~1', 'inst-b~2', 'inst-b~3', 'inst-b~4', 'inst-b~5',
    ]);
    expect(progress()?.projectsDone).toBe(10);

    // Les commits des deux instances s'additionnent, aucun n'est perdu.
    const total = [...dataset.daily.values()].reduce((sum, bucket) => sum + bucket.commits, 0);
    expect(total).toBe(200);

    // Et chaque instance porte bien la moitié.
    const perInstance = (id: string) =>
      [...dataset.daily.values()]
        .filter((bucket) => bucket.projectKey.startsWith(`${id}~`))
        .reduce((sum, bucket) => sum + bucket.commits, 0);
    expect(perInstance('inst-a')).toBe(100);
    expect(perInstance('inst-b')).toBe(100);
  });

  it('agrège une même personne présente sur les deux instances', async () => {
    const { a, b } = twoInstances(3, 12);
    const dataset = await loadDataset();
    await makeSync(
      [
        { instance: INSTANCE_A, fake: a },
        { instance: INSTANCE_B, fake: b },
      ],
      dataset,
      CONFIG,
      NOW,
    ).run();

    // Les deux faux serveurs utilisent les mêmes adresses e-mail : le résolveur
    // étant partagé, il ne doit rester qu'une entrée par personne.
    expect([...dataset.authors.keys()].sort()).toEqual([
      'a.riviere@example.com',
      'm.durand@example.com',
    ]);

    // Et ses commits couvrent bien les deux instances.
    const person = [...dataset.daily.values()].filter(
      (bucket) => bucket.authorId === 'a.riviere@example.com',
    );
    const instancesTouched = new Set(person.map((bucket) => bucket.projectKey.split('~')[0]));
    expect(instancesTouched).toEqual(new Set(['inst-a', 'inst-b']));
  });

  it('2ᵉ lancement : une seule liste de projets par instance', async () => {
    const { a, b } = twoInstances(10, 10);
    const first = await loadDataset();
    await makeSync(
      [
        { instance: INSTANCE_A, fake: a },
        { instance: INSTANCE_B, fake: b },
      ],
      first,
      CONFIG,
      NOW,
    ).run();

    a.calls = [];
    b.calls = [];
    await closeDb();
    const second = await loadDataset();
    const { run, progress } = makeSync(
      [
        { instance: INSTANCE_A, fake: a },
        { instance: INSTANCE_B, fake: b },
      ],
      second,
      CONFIG,
      NOW,
    );
    await run();

    expect(progress()?.projectsSkipped).toBe(20);
    expect(progress()?.projectsDone).toBe(0);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it('un token invalide sur une instance ne bloque pas les autres', async () => {
    const { a, b } = twoInstances(4, 10);
    const rejecting = (async () =>
      new Response(JSON.stringify({ message: '401 Unauthorized' }), { status: 401 })) as unknown as typeof fetch;

    const dataset = await loadDataset();
    const { run, progress } = makeSync(
      [
        { instance: { ...INSTANCE_A }, fake: { ...a, fetch: rejecting } as unknown as FakeGitLab },
        { instance: INSTANCE_B, fake: b },
      ],
      dataset,
      CONFIG,
      NOW,
    );
    await run();

    const byId = new Map(progress()!.instances.map((entry) => [entry.instanceId, entry]));
    expect(byId.get('inst-a')?.error).toContain('Token invalide');
    expect(byId.get('inst-b')?.error).toBeNull();

    // L'instance saine est allée au bout, ses données sont exploitables.
    expect([...dataset.projects.keys()].every((key) => key.startsWith('inst-b~'))).toBe(true);
    expect([...dataset.daily.values()].reduce((sum, bucket) => sum + bucket.commits, 0)).toBe(40);
    // Une instance en échec sur deux n'est PAS une erreur fatale globale.
    expect(progress()?.fatalError).toBeNull();
  });

  it("retirer une instance n'affecte pas les données de l'autre", async () => {
    const { a, b } = twoInstances(3, 10);
    const dataset = await loadDataset();
    await makeSync(
      [
        { instance: INSTANCE_A, fake: a },
        { instance: INSTANCE_B, fake: b },
      ],
      dataset,
      CONFIG,
      NOW,
    ).run();
    expect(dataset.projects.size).toBe(6);

    // Simulation du retrait ciblé opéré par le store.
    for (const [key, project] of [...dataset.projects]) {
      if (project.instanceId !== 'inst-a') continue;
      dataset.projects.delete(key);
    }
    for (const [key, bucket] of [...dataset.daily]) {
      if (bucket.projectKey.startsWith('inst-a~')) dataset.daily.delete(key);
    }

    expect(dataset.projects.size).toBe(3);
    expect([...dataset.daily.values()].reduce((sum, bucket) => sum + bucket.commits, 0)).toBe(30);
  });
});
