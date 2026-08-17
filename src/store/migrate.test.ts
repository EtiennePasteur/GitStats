import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { openDB } from 'idb';
import { migrateV1ToV2, inferLegacyHost, LEGACY_FALLBACK_HOST, type V1Snapshot } from './migrate';
import { getDb, deleteDatabase, closeDb, DB_NAME } from './db';
import { loadDataset } from './dataset';
import { deserializeDataset } from './serialize';
import { DEFAULT_SYNC_CONFIG } from '../model/types';

const NOW = '2026-08-17T12:00:00.000Z';

function v1Snapshot(): V1Snapshot {
  return {
    projects: [
      {
        id: 42,
        name: 'api',
        nameWithNamespace: 'G / api',
        pathWithNamespace: 'g/api',
        namespaceFullPath: 'g',
        defaultBranch: 'main',
        webUrl: 'https://gitlab.example.com/g/api',
        avatarUrl: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        archived: false,
        lastActivityAt: '2026-08-10T00:00:00.000Z',
        sync: {
          state: 'done',
          coveredFrom: '2025-08-17T12:00:00.000Z',
          coveredUntil: '2026-08-17T12:00:00.000Z',
          syncedActivityAt: '2026-08-10T00:00:00.000Z',
          lastSyncedAt: NOW,
          commitCount: 7,
          recentShas: ['sha1'],
          hasOverview: true,
          error: null,
          currentPage: 0,
          fingerprint: 'stats=1;branches=default',
        },
      },
    ],
    daily: [
      { key: '42|a@x.fr|2026-08-01', projectId: 42, authorId: 'a@x.fr', day: '2026-08-01', commits: 4, additions: 40, deletions: 5, merges: 0 },
      { key: '42|b@x.fr|2026-08-02', projectId: 42, authorId: 'b@x.fr', day: '2026-08-02', commits: 3, additions: 30, deletions: 2, merges: 1 },
    ],
    overviews: [{ projectId: 42, fetchedAt: NOW, entries: [{ authorId: 'a@x.fr', commits: 4, additions: 40, deletions: 5 }] }],
    recentCommits: [
      { key: '42|sha1', projectId: 42, sha: 'sha1', shortSha: 'sha1', authorId: 'a@x.fr', date: NOW, title: 't', additions: 1, deletions: 0, isMerge: false, webUrl: 'u' },
    ],
    meta: {
      schemaVersion: 1,
      host: 'https://gitlab.example.com',
      window: null,
      lastSyncAt: NOW,
      config: { ...DEFAULT_SYNC_CONFIG, host: 'https://gitlab.example.com' },
      manualAliases: { 'old@x.fr': 'a@x.fr' },
    } as V1Snapshot['meta'],
  };
}

describe('inferLegacyHost', () => {
  it('retrouve l\'hôte, quel que soit l\'endroit où il était rangé', () => {
    expect(inferLegacyHost({ host: 'https://a.net' } as never)).toBe('https://a.net');
    expect(inferLegacyHost({ config: { host: 'https://b.net' } } as never)).toBe('https://b.net');
    // Sans trace, on retombe sur un repli NON VIDE : une chaîne vide produirait
    // `instanceId('')` et donc la clé de projet `~42`.
    expect(inferLegacyHost(undefined)).toBe(LEGACY_FALLBACK_HOST);
    expect(LEGACY_FALLBACK_HOST).not.toBe('');
  });
});

describe('migrateV1ToV2 — transformation pure', () => {
  it('rattache tout à l\'instance d\'origine, sans rien perdre', () => {
    const result = migrateV1ToV2(v1Snapshot(), NOW);

    expect(result.instance.id).toBe('gitlab-example-com');
    expect(result.instance.host).toBe('https://gitlab.example.com');

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]!.key).toBe('gitlab-example-com~42');
    expect(result.projects[0]!.gitlabId).toBe(42);
    expect(result.projects[0]!.instanceId).toBe('gitlab-example-com');
    // L'état de synchronisation est préservé : sinon tout serait re-collecté.
    expect(result.projects[0]!.sync.coveredUntil).toBe('2026-08-17T12:00:00.000Z');
  });

  it('refait les clés de seau, qui embarquaient l\'identifiant de projet', () => {
    const result = migrateV1ToV2(v1Snapshot(), NOW);
    expect(result.daily.map((bucket) => bucket.key)).toEqual([
      'gitlab-example-com~42|a@x.fr|2026-08-01',
      'gitlab-example-com~42|b@x.fr|2026-08-02',
    ]);
    // Conserver l'ancienne clé ferait entrer en collision deux instances.
    expect(result.daily.every((bucket) => bucket.projectKey === 'gitlab-example-com~42')).toBe(true);
  });

  it('conserve les totaux au commit près', () => {
    const before = v1Snapshot();
    const result = migrateV1ToV2(before, NOW);
    const sum = (rows: Array<{ commits: number }>) => rows.reduce((total, row) => total + row.commits, 0);
    expect(sum(result.daily)).toBe(sum(before.daily));
    expect(result.daily.reduce((t, b) => t + b.additions, 0)).toBe(70);
  });

  it('conserve les fusions manuelles et retire l\'hôte de la config', () => {
    const result = migrateV1ToV2(v1Snapshot(), NOW);
    expect(result.meta!.manualAliases).toEqual({ 'old@x.fr': 'a@x.fr' });
    expect(result.meta!.instances).toHaveLength(1);
    expect('host' in result.meta!.config).toBe(false);
  });

  it('migre aperçus et commits récents', () => {
    const result = migrateV1ToV2(v1Snapshot(), NOW);
    expect(result.overviews[0]!.projectKey).toBe('gitlab-example-com~42');
    expect(result.recentCommits[0]!.key).toBe('gitlab-example-com~42|sha1');
  });
});

describe('migration IndexedDB v1 → v2', () => {
  beforeEach(async () => {
    await deleteDatabase();
  });

  /** Recrée une base au schéma v1, telle qu'elle existe chez un utilisateur. */
  async function seedV1(): Promise<void> {
    const snapshot = v1Snapshot();
    const db = await openDB(DB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore('meta');
        database.createObjectStore('projects', { keyPath: 'id' });
        database.createObjectStore('authors', { keyPath: 'id' });
        const daily = database.createObjectStore('daily', { keyPath: 'key' });
        // Le schéma v1 portait trois index ; la v2 n'en garde qu'un.
        daily.createIndex('by-project', 'projectId');
        daily.createIndex('by-author', 'authorId');
        daily.createIndex('by-day', 'day');
        database.createObjectStore('overview', { keyPath: 'projectId' });
        const recent = database.createObjectStore('recentCommits', { keyPath: 'key' });
        recent.createIndex('by-project', 'projectId');
        database.createObjectStore('rhythms', { keyPath: 'authorId' });
        database.createObjectStore('handles');
      },
    });
    for (const project of snapshot.projects) await db.put('projects', project);
    for (const bucket of snapshot.daily) await db.put('daily', bucket);
    for (const overview of snapshot.overviews) await db.put('overview', overview);
    for (const commit of snapshot.recentCommits) await db.put('recentCommits', commit);
    await db.put('authors', { id: 'a@x.fr', displayName: 'A', primaryEmail: 'a@x.fr', identityKeys: ['a@x.fr'], knownNames: [], knownEmails: [], isBot: false });
    await db.put('meta', snapshot.meta, 'meta');
    db.close();
  }

  it('convertit les données existantes au lieu de les perdre', async () => {
    await seedV1();
    await closeDb();

    // Première ouverture en v2 : la migration se déclenche.
    await getDb();
    const dataset = await loadDataset();

    expect(dataset.projects.size).toBe(1);
    expect([...dataset.projects.keys()]).toEqual(['gitlab-example-com~42']);
    expect(dataset.daily.size).toBe(2);
    expect([...dataset.daily.values()].reduce((sum, b) => sum + b.commits, 0)).toBe(7);
    expect(dataset.overviews.size).toBe(1);
    expect(dataset.recentCommits.size).toBe(1);
    // Les auteurs et les fusions manuelles traversent la migration intacts.
    expect(dataset.authors.size).toBe(1);
    expect(dataset.meta?.manualAliases).toEqual({ 'old@x.fr': 'a@x.fr' });
    expect(dataset.meta?.instances).toHaveLength(1);
  });

  it('une base neuve ne déclenche aucune migration', async () => {
    await getDb();
    const dataset = await loadDataset();
    expect(dataset.projects.size).toBe(0);
  });
});

describe('import d\'un fichier .json v1', () => {
  it('le convertit au lieu de le refuser', () => {
    const v1File = {
      format: 'gitstats',
      version: 1,
      gitlabHost: 'https://gitlab.example.com',
      generatedAt: NOW,
      window: null,
      config: DEFAULT_SYNC_CONFIG,
      manualAliases: {},
      projects: v1Snapshot().projects,
      authors: [
        { id: 'a@x.fr', displayName: 'A', primaryEmail: 'a@x.fr', identityKeys: ['a@x.fr'], knownNames: [], knownEmails: [], isBot: false },
        { id: 'b@x.fr', displayName: 'B', primaryEmail: 'b@x.fr', identityKeys: ['b@x.fr'], knownNames: [], knownEmails: [], isBot: false },
      ],
      authorIndex: ['a@x.fr', 'b@x.fr'],
      daily: [
        [42, 0, '2026-08-01', 4, 40, 5, 0],
        [42, 1, '2026-08-02', 3, 30, 2, 1],
      ],
      rhythms: [],
      overviews: v1Snapshot().overviews,
      recentCommits: v1Snapshot().recentCommits,
    };

    const dataset = deserializeDataset(v1File);

    expect([...dataset.projects.keys()]).toEqual(['gitlab-example-com~42']);
    expect(dataset.daily.size).toBe(2);
    expect([...dataset.daily.values()].reduce((sum, b) => sum + b.commits, 0)).toBe(7);
    // L'instance est reconstituée depuis l'ancien champ `gitlabHost`.
    expect(dataset.meta?.instances[0]?.id).toBe('gitlab-example-com');
    // Les auteurs restent correctement associés à leurs seaux.
    expect([...dataset.daily.values()].map((b) => b.authorId).sort()).toEqual(['a@x.fr', 'b@x.fr']);
  });
});
