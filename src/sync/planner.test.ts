import { describe, it, expect } from 'vitest';
import { planProject, planSync, windowStart, OVERLAP_MS } from './planner';
import { DEFAULT_SYNC_CONFIG, collectionFingerprint, type StoredProject, type SyncConfig } from '../model/types';
import type { GitLabProjectSimple } from '../gitlab/types';

const NOW = new Date('2026-08-17T12:00:00.000Z');
const INSTANCE = 'inst-a';
const P = (n: number): string => `${INSTANCE}~${n}`;
const CONFIG: SyncConfig = { ...DEFAULT_SYNC_CONFIG, windowMonths: 12 };

function remote(overrides: Partial<GitLabProjectSimple> = {}): GitLabProjectSimple {
  return {
    id: 1,
    name: 'api',
    path_with_namespace: 'backend/api',
    name_with_namespace: 'Backend / api',
    default_branch: 'main',
    web_url: 'https://git/backend/api',
    avatar_url: null,
    last_activity_at: '2026-08-10T09:00:00.000Z',
    created_at: '2020-01-01T00:00:00.000Z',
    namespace: { id: 2, name: 'Backend', path: 'backend', full_path: 'backend', kind: 'group' },
    ...overrides,
  };
}

function stored(overrides: Partial<StoredProject['sync']> = {}): StoredProject {
  return {
    key: P(1),
    gitlabId: 1,
    instanceId: INSTANCE,
    name: 'api',
    nameWithNamespace: 'Backend / api',
    pathWithNamespace: 'backend/api',
    namespaceFullPath: 'backend',
    defaultBranch: 'main',
    webUrl: 'https://git/backend/api',
    avatarUrl: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    archived: false,
    lastActivityAt: '2026-08-10T09:00:00.000Z',
    sync: {
      state: 'done',
      coveredFrom: '2025-08-17T12:00:00.000Z',
      coveredUntil: '2026-08-15T12:00:00.000Z',
      syncedActivityAt: '2026-08-10T09:00:00.000Z',
      lastSyncedAt: '2026-08-15T12:00:00.000Z',
      commitCount: 500,
      recentShas: [],
      hasOverview: true,
      error: null,
      currentPage: 0,
      fingerprint: collectionFingerprint(CONFIG),
      ...overrides,
    },
  };
}

describe('windowStart', () => {
  it('recule du nombre de mois demandé', () => {
    expect(windowStart(CONFIG, NOW)).toBe('2025-08-17T12:00:00.000Z');
    expect(windowStart({ ...CONFIG, windowMonths: 3 }, NOW)).toBe('2026-05-17T12:00:00.000Z');
  });

  it('renvoie null pour « tout l\'historique »', () => {
    expect(windowStart({ ...CONFIG, windowMonths: null }, NOW)).toBeNull();
  });
});

describe('planProject — premier passage', () => {
  it('collecte toute la fenêtre et demande l\'aperçu', () => {
    const plan = planProject(remote(), undefined, CONFIG, NOW, INSTANCE);
    expect(plan.shouldSync).toBe(true);
    expect(plan.needsOverview).toBe(true);
    expect(plan.ranges).toEqual([
      { since: '2025-08-17T12:00:00.000Z', until: NOW.toISOString(), kind: 'initial' },
    ]);
    expect(plan.projectKey).toBe(P(1));
  });
});

describe('planProject — incrémental', () => {
  it("saute complètement un dépôt qui n'a pas bougé (zéro appel)", () => {
    const plan = planProject(remote(), stored(), CONFIG, NOW, INSTANCE);
    expect(plan.shouldSync).toBe(false);
    expect(plan.ranges).toEqual([]);
    // Ne surtout pas redemander l'aperçu : ce serait 234 appels pour rien.
    expect(plan.needsOverview).toBe(false);
    expect(plan.reason).toContain('Inchangé');
  });

  it('ne récupère que le delta, avec un recouvrement, si le dépôt a bougé', () => {
    const plan = planProject(
      remote({ last_activity_at: '2026-08-16T18:00:00.000Z' }),
      stored(),
      CONFIG,
      NOW,
      INSTANCE,
    );
    expect(plan.shouldSync).toBe(true);
    expect(plan.ranges).toHaveLength(1);
    const expectedSince = new Date(
      new Date('2026-08-15T12:00:00.000Z').getTime() - OVERLAP_MS,
    ).toISOString();
    expect(plan.ranges[0]).toEqual({
      since: expectedSince,
      until: NOW.toISOString(),
      kind: 'incremental',
    });
    // L'aperçu all-time est déjà connu et ne se filtre pas par date.
    expect(plan.needsOverview).toBe(false);
  });

  it('retente un projet en erreur même sans nouvelle activité', () => {
    const plan = planProject(remote(), stored({ state: 'error', error: 'boom' }), CONFIG, NOW, INSTANCE);
    expect(plan.shouldSync).toBe(true);
    expect(plan.ranges[0]?.kind).toBe('refresh');
  });
});

describe('planProject — fenêtre élargie', () => {
  it("ne va chercher QUE le trou manquant, pas toute la fenêtre", () => {
    const plan = planProject(remote(), stored(), { ...CONFIG, windowMonths: 24 }, NOW, INSTANCE);
    expect(plan.shouldSync).toBe(true);
    expect(plan.ranges).toEqual([
      {
        since: '2024-08-17T12:00:00.000Z',
        until: '2025-08-17T12:00:00.000Z', // s'arrête là où la couverture commence
        kind: 'backfill',
      },
    ]);
  });

  it('combine rattrapage ancien et delta récent', () => {
    const plan = planProject(
      remote({ last_activity_at: '2026-08-16T18:00:00.000Z' }),
      stored(),
      { ...CONFIG, windowMonths: 24 },
      NOW,
      INSTANCE,
    );
    expect(plan.ranges.map((r) => r.kind)).toEqual(['backfill', 'incremental']);
  });

  it("gère le passage à « tout l'historique »", () => {
    const plan = planProject(remote(), stored(), { ...CONFIG, windowMonths: null }, NOW, INSTANCE);
    expect(plan.ranges).toEqual([
      { since: null, until: '2025-08-17T12:00:00.000Z', kind: 'backfill' },
    ]);
  });

  it('ne redemande rien si la fenêtre est rétrécie', () => {
    // 12 → 3 mois : les données déjà là couvrent largement, aucun appel.
    const plan = planProject(remote(), stored(), { ...CONFIG, windowMonths: 3 }, NOW, INSTANCE);
    expect(plan.shouldSync).toBe(false);
  });
});

describe('planProject — changement d\'options de collecte', () => {
  it('force un re-sync complet avec purge quand with_stats est activé', () => {
    const plan = planProject(remote(), stored(), { ...CONFIG, withStats: !CONFIG.withStats }, NOW, INSTANCE);
    expect(plan.shouldSync).toBe(true);
    expect(plan.resetExisting).toBe(true);
    expect(plan.ranges[0]?.kind).toBe('initial');
    expect(plan.reason).toContain('Options de collecte');
  });

  it('force un re-sync complet quand on passe à toutes les branches', () => {
    const plan = planProject(remote(), stored(), { ...CONFIG, allBranches: true }, NOW, INSTANCE);
    expect(plan.resetExisting).toBe(true);
  });
});

describe('planSync — bilan sur un parc réaliste', () => {
  const buildParc = (count: number, movedCount: number) => {
    const remotes: GitLabProjectSimple[] = [];
    const storedById = new Map<string, StoredProject>();
    for (let i = 1; i <= count; i++) {
      const moved = i <= movedCount;
      remotes.push(
        remote({ id: i, last_activity_at: moved ? '2026-08-16T18:00:00.000Z' : '2026-08-10T09:00:00.000Z' }),
      );
      storedById.set(P(i), { ...stored(), key: P(i), gitlabId: i });
    }
    return { remotes, storedById };
  };

  it('premier lancement : tous les projets sont à collecter', () => {
    const { remotes } = buildParc(234, 0);
    const summary = planSync(remotes, new Map(), CONFIG, NOW, INSTANCE);
    expect(summary.toSync).toBe(234);
    expect(summary.skipped).toBe(0);
    // 234 aperçus + 234 premières pages de commits.
    expect(summary.minimumRequests).toBe(468);
  });

  it('2ᵉ lancement : seuls les dépôts actifs coûtent des appels', () => {
    const { remotes, storedById } = buildParc(234, 30);
    const summary = planSync(remotes, storedById, CONFIG, NOW, INSTANCE);
    expect(summary.toSync).toBe(30);
    expect(summary.skipped).toBe(204);
    // 30 plages, et surtout AUCUN aperçu redemandé.
    expect(summary.minimumRequests).toBe(30);
  });

  it('parc totalement inchangé : plus aucun appel projet', () => {
    const { remotes, storedById } = buildParc(234, 0);
    const summary = planSync(remotes, storedById, CONFIG, NOW, INSTANCE);
    expect(summary.toSync).toBe(0);
    expect(summary.minimumRequests).toBe(0);
  });
});
