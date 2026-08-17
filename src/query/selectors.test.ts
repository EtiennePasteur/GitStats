import { describe, it, expect } from 'vitest';
import {
  filterBuckets,
  computeTotals,
  byAuthor,
  byProject,
  byDay,
  byDayAndAuthor,
  fillDays,
  namespaceTree,
  EMPTY_FILTERS,
  type Filters,
} from './selectors';
import type { DailyBucket, StoredAuthor, StoredProject } from '../model/types';

const P = (n: number): string => `inst-a~${n}`;

function bucket(over: Partial<DailyBucket> = {}): DailyBucket {
  const base: DailyBucket = {
    key: 'k',
    projectKey: P(1),
    authorId: 'a.riviere@example.com',
    day: '2026-08-17',
    commits: 3,
    additions: 30,
    deletions: 10,
    merges: 0,
    ...over,
  };
  return { ...base, key: `${base.projectKey}|${base.authorId}|${base.day}` };
}

const AUTHORS = new Map<string, StoredAuthor>([
  [
    'a.riviere@example.com',
    {
      id: 'a.riviere@example.com',
      displayName: 'Amélie Rivière',
      primaryEmail: 'a.riviere@example.com',
      identityKeys: ['a.riviere@example.com'],
      knownNames: [],
      knownEmails: [],
      isBot: false,
    },
  ],
  [
    'gitlab-ci@example.com',
    {
      id: 'gitlab-ci@example.com',
      displayName: 'GitLab CI',
      primaryEmail: 'gitlab-ci@example.com',
      identityKeys: ['gitlab-ci@example.com'],
      knownNames: [],
      knownEmails: [],
      isBot: true,
    },
  ],
]);

function project(id: number, namespaceFullPath: string, path: string): StoredProject {
  return {
    key: P(id),
    gitlabId: id,
    instanceId: 'inst-a',
    name: path.split('/').pop() ?? path,
    nameWithNamespace: path,
    pathWithNamespace: path,
    namespaceFullPath,
    defaultBranch: 'main',
    webUrl: '',
    avatarUrl: null,
    createdAt: '2024-01-01T00:00:00Z',
    archived: false,
    lastActivityAt: '2026-08-17T00:00:00Z',
    sync: {
      state: 'done',
      coveredFrom: null,
      coveredUntil: null,
      syncedActivityAt: null,
      lastSyncedAt: null,
      commitCount: 0,
      recentShas: [],
      hasOverview: true,
      error: null,
      currentPage: 0,
      fingerprint: 'x',
    },
  };
}

const PROJECTS = new Map<string, StoredProject>([
  [P(1), project(1, 'backend/api', 'backend/api/gateway')],
  [P(2), project(2, 'backend', 'backend/services')],
  [P(3), project(3, 'data', 'data/etl')],
]);

const f = (over: Partial<Filters> = {}): Filters => ({ ...EMPTY_FILTERS, ...over });

describe('filterBuckets', () => {
  const all = [
    bucket({ projectKey: P(1), day: '2026-08-01' }),
    bucket({ projectKey: P(2), day: '2026-08-17' }),
    bucket({ projectKey: P(3), day: '2026-09-01' }),
    bucket({ projectKey: P(1), day: '2026-08-17', authorId: 'gitlab-ci@example.com' }),
  ];

  it('filtre sur la plage de dates, bornes incluses', () => {
    const kept = filterBuckets(all, f({ from: '2026-08-01', to: '2026-08-17' }), AUTHORS, PROJECTS);
    expect(kept.map((b) => b.day).sort()).toEqual(['2026-08-01', '2026-08-17']);
  });

  it('exclut les bots par défaut', () => {
    const kept = filterBuckets(all, f(), AUTHORS, PROJECTS);
    expect(kept.every((b) => b.authorId !== 'gitlab-ci@example.com')).toBe(true);
    const withBots = filterBuckets(all, f({ excludeBots: false }), AUTHORS, PROJECTS);
    expect(withBots).toHaveLength(4);
  });

  it('inclut les sous-groupes quand un groupe parent est sélectionné', () => {
    const kept = filterBuckets(all, f({ namespaces: new Set(['backend']) }), AUTHORS, PROJECTS);
    // `backend` doit couvrir `backend/api`, sinon le filtre par entité est inutilisable.
    expect(new Set(kept.map((b) => b.projectKey))).toEqual(new Set([P(1), P(2)]));
  });

  it('filtre par projet et par auteur', () => {
    expect(filterBuckets(all, f({ projectKeys: new Set([P(3)]) }), AUTHORS, PROJECTS)).toHaveLength(1);
    expect(
      filterBuckets(all, f({ authorIds: new Set(['a.riviere@example.com']) }), AUTHORS, PROJECTS),
    ).toHaveLength(3);
  });

  it('cherche dans le chemin complet du projet', () => {
    const kept = filterBuckets(all, f({ search: 'espace' }), AUTHORS, PROJECTS);
    expect(kept.every((b) => b.projectKey === P(1))).toBe(true);
  });

  it('excludeMerges retire les merges du compte de commits, pas des lignes', () => {
    const withMerges = [bucket({ commits: 10, merges: 4, additions: 100, deletions: 20 })];
    const kept = filterBuckets(withMerges, f({ excludeMerges: true }), AUTHORS, PROJECTS);
    expect(kept[0]!.commits).toBe(6);
    expect(kept[0]!.merges).toBe(0);
    // Les lignes excluent déjà les merges depuis l'ingestion : elles ne bougent pas.
    expect(kept[0]!.additions).toBe(100);
  });

  it('supprime un seau devenu vide après exclusion des merges', () => {
    const onlyMerges = [bucket({ commits: 3, merges: 3 })];
    expect(filterBuckets(onlyMerges, f({ excludeMerges: true }), AUTHORS, PROJECTS)).toHaveLength(0);
  });

  it('ne mute jamais les seaux d\'origine', () => {
    const source = [bucket({ commits: 10, merges: 4 })];
    filterBuckets(source, f({ excludeMerges: true }), AUTHORS, PROJECTS);
    expect(source[0]!.commits).toBe(10);
    expect(source[0]!.merges).toBe(4);
  });
});

describe('agrégations', () => {
  const buckets = [
    bucket({ projectKey: P(1), authorId: 'a', day: '2026-08-01', commits: 2, additions: 20, deletions: 5 }),
    bucket({ projectKey: P(1), authorId: 'a', day: '2026-08-03', commits: 3, additions: 30, deletions: 5 }),
    bucket({ projectKey: P(2), authorId: 'a', day: '2026-08-03', commits: 1, additions: 10, deletions: 0 }),
    bucket({ projectKey: P(1), authorId: 'b', day: '2026-08-03', commits: 5, additions: 50, deletions: 10 }),
  ];

  it('calcule les totaux et les cardinalités distinctes', () => {
    const totals = computeTotals(buckets);
    expect(totals.commits).toBe(11);
    expect(totals.additions).toBe(110);
    expect(totals.activeAuthors).toBe(2);
    expect(totals.activeProjects).toBe(2);
    expect(totals.activeDays).toBe(2);
  });

  it('classe les auteurs par volume et compte leurs projets', () => {
    const stats = byAuthor(buckets);
    expect(stats.map((s) => s.authorId)).toEqual(['a', 'b']);
    expect(stats[0]!.commits).toBe(6);
    expect(stats[0]!.projectKeys.size).toBe(2);
    expect(stats[0]!.firstDay).toBe('2026-08-01');
    expect(stats[0]!.lastDay).toBe('2026-08-03');
  });

  it('compte des jours DISTINCTS, pas des seaux', () => {
    // « a » a travaillé sur 2 dépôts le 3 août : cela fait 2 seaux mais un seul
    // jour. Compter les seaux donnerait des « jours actifs » supérieurs à la
    // durée de la période.
    const stats = byAuthor(buckets);
    expect(stats.find((s) => s.authorId === 'a')!.activeDays).toBe(2);
    expect(stats.find((s) => s.authorId === 'b')!.activeDays).toBe(1);
  });

  it('classe les projets par volume', () => {
    const stats = byProject(buckets);
    expect(stats[0]!.projectKey).toBe(P(1));
    expect(stats[0]!.commits).toBe(10);
    expect(stats[0]!.authorIds.size).toBe(2);
    // Deux auteurs le 3 août sur le dépôt 1 ⇒ 2 jours actifs, pas 3.
    expect(stats[0]!.activeDays).toBe(2);
  });

  it('ne dépasse jamais la durée de la période', () => {
    const days = fillDays('2026-01-01', '2026-12-31');
    const many = days.flatMap((day) =>
      [1, 2, 3, 4, 5].map((n) => bucket({ projectKey: P(n), authorId: 'a', day, commits: 1 })),
    );
    const stats = byAuthor(many);
    expect(stats[0]!.activeDays).toBe(days.length);
  });

  it('remplit les jours sans activité pour ne pas mentir sur les creux', () => {
    const points = byDay(buckets);
    expect(points.map((p) => p.day)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(points[1]).toEqual({ day: '2026-08-02', commits: 0, additions: 0, deletions: 0 });
    expect(points[2]!.commits).toBe(9);
  });
});

describe('byDayAndAuthor', () => {
  const buckets = [
    bucket({ authorId: 'a', day: '2026-08-01', commits: 2 }),
    bucket({ authorId: 'b', day: '2026-08-01', commits: 3 }),
    bucket({ authorId: 'c', day: '2026-08-02', commits: 4 }),
    bucket({ authorId: 'd', day: '2026-08-02', commits: 1 }),
  ];

  it('replie les auteurs non nommés dans « Autres » plutôt que d\'inventer une teinte', () => {
    const result = byDayAndAuthor(buckets, ['a', 'b']);
    expect(result.days).toEqual(['2026-08-01', '2026-08-02']);
    // « Autres » vient EN PREMIER, donc au bas de la pile : cette bande agrège
    // toute la longue traîne et écraserait les séries nommées si elle coiffait
    // le graphique.
    expect(result.series.map((s) => s.authorId)).toEqual(['__other__', 'a', 'b']);
    // c et d cumulés le 2 août.
    expect(result.series.find((s) => s.authorId === '__other__')!.values).toEqual([0, 5]);
  });

  it('n\'ajoute pas de série « Autres » quand tout le monde est nommé', () => {
    const result = byDayAndAuthor(buckets, ['a', 'b', 'c', 'd']);
    expect(result.series.map((s) => s.authorId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('conserve une série nommée même si elle est vide sur la période', () => {
    // Sinon la couleur d'une personne « saute » selon la plage sélectionnée.
    const result = byDayAndAuthor([bucket({ authorId: 'a', day: '2026-08-01' })], ['a', 'z']);
    expect(result.series.map((s) => s.authorId)).toEqual(['a', 'z']);
    expect(result.series[1]!.values).toEqual([0]);
  });
});

describe('utilitaires', () => {
  it('fillDays couvre les bornes incluses et franchit les mois', () => {
    expect(fillDays('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
    expect(fillDays('2026-08-17', '2026-08-17')).toEqual(['2026-08-17']);
    expect(fillDays('2026-08-18', '2026-08-17')).toEqual([]);
  });

  it('namespaceTree agrège les groupes parents', () => {
    const tree = namespaceTree(PROJECTS.values());
    expect(tree).toEqual([
      { path: 'backend', count: 2 },
      { path: 'backend/api', count: 1 },
      { path: 'data', count: 1 },
    ]);
  });
});

describe('performance', () => {
  it('filtre et agrège 150 000 seaux sous 100 ms', () => {
    const many: DailyBucket[] = [];
    for (let p = 1; p <= 234; p++) {
      for (let a = 0; a < 12; a++) {
        for (let d = 0; d < 55; d++) {
          many.push(
            bucket({
              projectKey: P(p),
              authorId: `auteur-${a}`,
              day: `2026-0${(d % 9) + 1}-${String((d % 28) + 1).padStart(2, '0')}`,
              commits: 2,
            }),
          );
        }
      }
    }
    expect(many.length).toBeGreaterThan(150_000);

    const started = performance.now();
    const kept = filterBuckets(many, f({ from: '2026-02-01', to: '2026-08-31' }), AUTHORS, PROJECTS);
    computeTotals(kept);
    byAuthor(kept);
    byProject(kept);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(100);
  });
});
