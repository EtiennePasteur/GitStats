/**
 * Persistance IndexedDB.
 *
 * Choix structurant : on ne stocke JAMAIS les commits bruts. L'agrégation en
 * seaux (projet, auteur, jour) est faite à l'ingestion. Sur 234 dépôts et 12 mois,
 * le brut représenterait des centaines de Mo pour aucune analyse supplémentaire,
 * alors que les seaux tiennent en quelques Mo et se requêtent instantanément.
 * Seuls les N derniers commits par projet sont conservés, pour le fil d'activité.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  ProjectKey,
  StoredProject,
  StoredAuthor,
  DailyBucket,
  ProjectOverview,
  RecentCommit,
  AuthorRhythm,
  StoredMeta,
} from '../model/types';
import {
  migrateV1ToV2,
  type V1Snapshot,
  type V1Project,
  type V1DailyBucket,
  type V1ProjectOverview,
  type V1RecentCommit,
  type V1Meta,
} from './migrate';

export const SCHEMA_VERSION = 2;
export const DB_NAME = 'gitstats';
/** Nombre de commits conservés par projet pour le fil d'activité. */
export const RECENT_COMMITS_PER_PROJECT = 100;

interface GitStatsSchema extends DBSchema {
  meta: { key: string; value: StoredMeta };
  projects: { key: ProjectKey; value: StoredProject };
  authors: { key: string; value: StoredAuthor };
  daily: {
    key: string;
    value: DailyBucket;
    /**
     * Un seul index, et c'est délibéré.
     *
     * Les filtres par auteur et par date s'exécutent en mémoire sur le Dataset,
     * jamais via IndexedDB — un balayage de 150 000 seaux prend moins de 100 ms.
     * En revanche chaque index est maintenu à CHAQUE écriture : sur un import de
     * 30 000 seaux, deux index inutiles coûtaient ~15 secondes.
     */
    indexes: { 'by-project': ProjectKey };
  };
  overview: { key: ProjectKey; value: ProjectOverview };
  recentCommits: {
    key: string;
    value: RecentCommit;
    indexes: { 'by-project': ProjectKey };
  };
  rhythms: { key: string; value: AuthorRhythm };
  /** Handle du fichier .json lié (File System Access API). */
  handles: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<GitStatsSchema>> | null = null;

export function getDb(): Promise<IDBPDatabase<GitStatsSchema>> {
  dbPromise ??= openDB<GitStatsSchema>(DB_NAME, SCHEMA_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      // v1 → v2 : les projets passent d'un identifiant numérique GitLab à une clé
      // préfixée par l'instance. Les `keyPath` changent, donc les magasins
      // concernés doivent être recréés — on relit d'abord leur contenu pour le
      // réécrire transformé, plutôt que de faire perdre à l'utilisateur une
      // collecte de plusieurs minutes.
      let legacy: V1Snapshot | null = null;
      if (oldVersion >= 1 && db.objectStoreNames.contains('projects')) {
        legacy = {
          projects: (await tx.objectStore('projects' as never).getAll()) as V1Project[],
          daily: db.objectStoreNames.contains('daily')
            ? ((await tx.objectStore('daily' as never).getAll()) as V1DailyBucket[])
            : [],
          overviews: db.objectStoreNames.contains('overview')
            ? ((await tx.objectStore('overview' as never).getAll()) as V1ProjectOverview[])
            : [],
          recentCommits: db.objectStoreNames.contains('recentCommits')
            ? ((await tx.objectStore('recentCommits' as never).getAll()) as V1RecentCommit[])
            : [],
          meta: db.objectStoreNames.contains('meta')
            ? ((await tx.objectStore('meta' as never).get('meta')) as V1Meta | undefined)
            : undefined,
        };
        for (const name of ['projects', 'daily', 'overview', 'recentCommits'] as const) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        }
      }

      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('authors')) db.createObjectStore('authors', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('daily')) {
        const store = db.createObjectStore('daily', { keyPath: 'key' });
        store.createIndex('by-project', 'projectKey');
      }
      if (!db.objectStoreNames.contains('overview')) {
        db.createObjectStore('overview', { keyPath: 'projectKey' });
      }
      if (!db.objectStoreNames.contains('recentCommits')) {
        const store = db.createObjectStore('recentCommits', { keyPath: 'key' });
        store.createIndex('by-project', 'projectKey');
      }
      if (!db.objectStoreNames.contains('rhythms')) {
        db.createObjectStore('rhythms', { keyPath: 'authorId' });
      }
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');

      if (legacy !== null) {
        const migrated = migrateV1ToV2(legacy, new Date().toISOString());
        for (const project of migrated.projects) await tx.objectStore('projects').put(project);
        for (const bucket of migrated.daily) await tx.objectStore('daily').put(bucket);
        for (const overview of migrated.overviews) await tx.objectStore('overview').put(overview);
        for (const commit of migrated.recentCommits) await tx.objectStore('recentCommits').put(commit);
        if (migrated.meta !== undefined) await tx.objectStore('meta').put(migrated.meta, 'meta');
      }
    },
  });
  return dbPromise;
}

/** Réinitialise le singleton — utilisé par les tests et après une purge. */
export function resetDbCache(): void {
  dbPromise = null;
}

/**
 * Ferme réellement la connexion IndexedDB.
 *
 * Indispensable avant un `deleteDatabase` : tant qu'une connexion reste ouverte,
 * la suppression est mise en attente indéfiniment (elle attend un `versionchange`
 * qui ne viendra jamais).
 */
export async function closeDb(): Promise<void> {
  if (dbPromise === null) return;
  const pending = dbPromise;
  dbPromise = null;
  try {
    (await pending).close();
  } catch {
    // Connexion déjà fermée ou jamais ouverte : rien à faire.
  }
}

/** Supprime entièrement la base. Utilisé par la purge et par les tests. */
export async function deleteDatabase(): Promise<void> {
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

// --- meta -------------------------------------------------------------

export async function readMeta(): Promise<StoredMeta | undefined> {
  return (await getDb()).get('meta', 'meta');
}

export async function writeMeta(meta: StoredMeta): Promise<void> {
  await (await getDb()).put('meta', meta, 'meta');
}

// --- projets ----------------------------------------------------------

export async function readProjects(): Promise<StoredProject[]> {
  return (await getDb()).getAll('projects');
}

export async function writeProjects(projects: StoredProject[]): Promise<void> {
  if (projects.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('projects', 'readwrite');
  await Promise.all([...projects.map((project) => tx.store.put(project)), tx.done]);
}

export async function writeProject(project: StoredProject): Promise<void> {
  await (await getDb()).put('projects', project);
}

// --- auteurs ----------------------------------------------------------

export async function readAuthors(): Promise<StoredAuthor[]> {
  return (await getDb()).getAll('authors');
}

export async function writeAuthors(authors: StoredAuthor[]): Promise<void> {
  if (authors.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('authors', 'readwrite');
  await Promise.all([...authors.map((author) => tx.store.put(author)), tx.done]);
}

export async function replaceAuthors(authors: StoredAuthor[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('authors', 'readwrite');
  await tx.store.clear();
  await Promise.all([...authors.map((author) => tx.store.put(author)), tx.done]);
}

// --- seaux journaliers ------------------------------------------------

export async function readDaily(): Promise<DailyBucket[]> {
  return (await getDb()).getAll('daily');
}

/**
 * Écrit les seaux en additionnant sur l'existant.
 *
 * L'addition (plutôt qu'un remplacement) est indispensable : un sync incrémental
 * ne rapporte que les nouveaux commits d'une journée déjà partiellement couverte.
 * La déduplication par SHA en amont garantit qu'on n'additionne jamais deux fois
 * le même commit.
 */
export async function mergeDaily(buckets: DailyBucket[]): Promise<void> {
  if (buckets.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('daily', 'readwrite');
  await Promise.all(
    buckets.map(async (bucket) => {
      const existing = await tx.store.get(bucket.key);
      if (existing === undefined) {
        await tx.store.put(bucket);
        return;
      }
      await tx.store.put({
        ...existing,
        commits: existing.commits + bucket.commits,
        additions: existing.additions + bucket.additions,
        deletions: existing.deletions + bucket.deletions,
        merges: existing.merges + bucket.merges,
      });
    }),
  );
  await tx.done;
}

/**
 * Remplace intégralement (import d'un fichier .json).
 *
 * Écriture par lots : une transaction unique de 30 000 `put` fait gonfler la
 * file interne d'IndexedDB et bloque le thread principal plusieurs secondes.
 * Découper laisse le navigateur respirer entre deux lots.
 */
export async function replaceDaily(buckets: DailyBucket[]): Promise<void> {
  const db = await getDb();
  await db.clear('daily');
  await writeInBatches(db, 'daily', buckets);
}

const WRITE_BATCH_SIZE = 2_000;

async function writeInBatches<S extends 'daily' | 'recentCommits'>(
  db: IDBPDatabase<GitStatsSchema>,
  store: S,
  values: Array<GitStatsSchema[S]['value']>,
): Promise<void> {
  for (let offset = 0; offset < values.length; offset += WRITE_BATCH_SIZE) {
    const batch = values.slice(offset, offset + WRITE_BATCH_SIZE);
    const tx = db.transaction(store, 'readwrite');
    for (const value of batch) void tx.store.put(value);
    await tx.done;
  }
}

/** Supprime les seaux d'un projet — utilisé avant un re-sync complet. */
export async function deleteDailyForProject(projectKey: ProjectKey): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('daily', 'readwrite');
  const index = tx.store.index('by-project');
  let cursor = await index.openCursor(IDBKeyRange.only(projectKey));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

// --- aperçus ----------------------------------------------------------

export async function readOverviews(): Promise<ProjectOverview[]> {
  return (await getDb()).getAll('overview');
}

export async function writeOverview(overview: ProjectOverview): Promise<void> {
  await (await getDb()).put('overview', overview);
}

// --- commits récents --------------------------------------------------

export async function readRecentCommits(): Promise<RecentCommit[]> {
  return (await getDb()).getAll('recentCommits');
}

/** Conserve au plus `RECENT_COMMITS_PER_PROJECT` commits par projet, les plus récents. */
export async function writeRecentCommits(projectKey: ProjectKey, commits: RecentCommit[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('recentCommits', 'readwrite');
  const index = tx.store.index('by-project');
  const existing = await index.getAll(IDBKeyRange.only(projectKey));

  const byKey = new Map<string, RecentCommit>();
  for (const commit of existing) byKey.set(commit.key, commit);
  for (const commit of commits) byKey.set(commit.key, commit);

  const kept = [...byKey.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, RECENT_COMMITS_PER_PROJECT);
  const keptKeys = new Set(kept.map((commit) => commit.key));

  for (const commit of existing) {
    if (!keptKeys.has(commit.key)) await tx.store.delete(commit.key);
  }
  await Promise.all([...kept.map((commit) => tx.store.put(commit)), tx.done]);
}

export async function replaceRecentCommits(commits: RecentCommit[]): Promise<void> {
  const db = await getDb();
  await db.clear('recentCommits');
  await writeInBatches(db, 'recentCommits', commits);
}

// --- rythmes ----------------------------------------------------------

export async function readRhythms(): Promise<AuthorRhythm[]> {
  return (await getDb()).getAll('rhythms');
}

export async function mergeRhythms(rhythms: AuthorRhythm[]): Promise<void> {
  if (rhythms.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('rhythms', 'readwrite');
  await Promise.all(
    rhythms.map(async (rhythm) => {
      const existing = await tx.store.get(rhythm.authorId);
      if (existing === undefined) {
        await tx.store.put(rhythm);
        return;
      }
      await tx.store.put({
        authorId: rhythm.authorId,
        hours: existing.hours.map((value, i) => value + (rhythm.hours[i] ?? 0)),
        weekdays: existing.weekdays.map((value, i) => value + (rhythm.weekdays[i] ?? 0)),
      });
    }),
  );
  await tx.done;
}

export async function replaceRhythms(rhythms: AuthorRhythm[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('rhythms', 'readwrite');
  await tx.store.clear();
  await Promise.all([...rhythms.map((rhythm) => tx.store.put(rhythm)), tx.done]);
}

// --- handle de fichier ------------------------------------------------

export async function readFileHandle<T>(): Promise<T | undefined> {
  return (await getDb()).get('handles', 'dataFile') as Promise<T | undefined>;
}

export async function writeFileHandle(handle: unknown): Promise<void> {
  await (await getDb()).put('handles', handle, 'dataFile');
}

export async function clearFileHandle(): Promise<void> {
  await (await getDb()).delete('handles', 'dataFile');
}

// --- maintenance ------------------------------------------------------

export interface StorageUsage {
  projects: number;
  authors: number;
  daily: number;
  recentCommits: number;
  /** Estimation navigateur, en octets. */
  estimatedBytes: number | null;
  quotaBytes: number | null;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const db = await getDb();
  const [projects, authors, daily, recentCommits] = await Promise.all([
    db.count('projects'),
    db.count('authors'),
    db.count('daily'),
    db.count('recentCommits'),
  ]);

  let estimatedBytes: number | null = null;
  let quotaBytes: number | null = null;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      estimatedBytes = estimate.usage ?? null;
      quotaBytes = estimate.quota ?? null;
    } catch {
      // L'estimation est un confort, son absence ne doit rien casser.
    }
  }
  return { projects, authors, daily, recentCommits, estimatedBytes, quotaBytes };
}

/** Purge les données analytiques. `keepConfig` conserve meta + handle de fichier. */
export async function clearAllData(keepConfig = true): Promise<void> {
  const db = await getDb();
  const stores = ['projects', 'authors', 'daily', 'overview', 'recentCommits', 'rhythms'] as const;
  await Promise.all(stores.map((store) => db.clear(store)));
  if (!keepConfig) {
    await db.clear('meta');
    await db.clear('handles');
  }
}
