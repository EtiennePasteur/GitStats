/**
 * Format du fichier `.json` d'export/import.
 *
 * Les seaux journaliers sont packés en tuples et les auteurs référencés par
 * index : sur un parc de 234 dépôts, la forme « objets nommés » pèse environ
 * trois fois plus lourd (les clés `projectId` / `additions` / … sont répétées à
 * chaque ligne). Le fichier reste du JSON lisible et diffable.
 *
 * Le token n'y figure JAMAIS : ce fichier a vocation à être posé sur un disque
 * partagé ou envoyé à un collègue.
 */

import type {
  ProjectKey,
  GitLabInstance,
  StoredProject,
  StoredAuthor,
  DailyBucket,
  ProjectOverview,
  RecentCommit,
  SyncConfig,
  SyncWindow,
} from '../model/types';
import { DEFAULT_SYNC_CONFIG } from '../model/types';
import { sanitizeHours } from '../model/hours';
import type { Dataset } from './dataset';
import { emptyDataset } from './dataset';

export const FILE_FORMAT = 'gitstats';
export const FILE_VERSION = 1;

/**
 * `[projectIndex, authorIndex, day, commits, additions, deletions, merges,
 *   hourly, hourlyMerges]`
 *
 * Les clés de projet sont des chaînes (`instance~42`) : les indexer comme les
 * auteurs évite de répéter le nom de l'instance sur chacune des dizaines de
 * milliers de lignes.
 */
type PackedDaily = [number, number, string, number, number, number, number, number[], number[]];

export interface GitStatsFile {
  format: typeof FILE_FORMAT;
  version: number;
  instances: GitLabInstance[];
  generatedAt: string;
  window: SyncWindow | null;
  config: Omit<SyncConfig, 'forceFullResync'>;
  manualAliases: Record<string, string>;
  projects: StoredProject[];
  authors: StoredAuthor[];
  /** Table de correspondance index → id d'auteur, référencée par `daily`. */
  authorIndex: string[];
  /** Idem pour les clés de projet. */
  projectIndex: ProjectKey[];
  daily: PackedDaily[];
  overviews: ProjectOverview[];
  recentCommits: RecentCommit[];
}

export function serializeDataset(dataset: Dataset): GitStatsFile {
  const authorIndex = [...dataset.authors.keys()];
  const indexOf = new Map(authorIndex.map((id, i) => [id, i]));

  // Un seau peut référencer un auteur absent de la table (fusion en cours) :
  // on l'ajoute plutôt que de perdre la ligne.
  const resolveIndex = (authorId: string): number => {
    let index = indexOf.get(authorId);
    if (index === undefined) {
      index = authorIndex.length;
      authorIndex.push(authorId);
      indexOf.set(authorId, index);
    }
    return index;
  };

  const projectIndex: ProjectKey[] = [...dataset.projects.keys()];
  const projectIndexOf = new Map(projectIndex.map((key, i) => [key, i]));
  const resolveProject = (key: ProjectKey): number => {
    let index = projectIndexOf.get(key);
    if (index === undefined) {
      index = projectIndex.length;
      projectIndex.push(key);
      projectIndexOf.set(key, index);
    }
    return index;
  };

  const daily: PackedDaily[] = [];
  for (const bucket of dataset.daily.values()) {
    daily.push([
      resolveProject(bucket.projectKey),
      resolveIndex(bucket.authorId),
      bucket.day,
      bucket.commits,
      bucket.additions,
      bucket.deletions,
      bucket.merges,
      bucket.hourly,
      bucket.hourlyMerges,
    ]);
  }

  const { forceFullResync: _ignored, ...config } = dataset.meta?.config ?? DEFAULT_SYNC_CONFIG;

  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    // Les tokens ne sont JAMAIS sérialisés : ce fichier est partageable.
    instances: dataset.meta?.instances ?? [],
    generatedAt: new Date().toISOString(),
    window: dataset.meta?.window ?? null,
    config,
    manualAliases: dataset.meta?.manualAliases ?? {},
    projects: [...dataset.projects.values()],
    authors: [...dataset.authors.values()],
    authorIndex,
    projectIndex,
    daily,
    overviews: [...dataset.overviews.values()],
    recentCommits: [...dataset.recentCommits.values()],
  };
}

export class InvalidFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFileError';
  }
}

export function deserializeDataset(raw: unknown): Dataset {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidFileError("Le fichier n'est pas un objet JSON.");
  }
  const file = raw as Partial<GitStatsFile>;
  if (file.format !== FILE_FORMAT) {
    throw new InvalidFileError(
      "Ce fichier n'a pas été produit par GitStats (champ « format » absent ou incorrect).",
    );
  }
  if (file.version !== FILE_VERSION) {
    throw new InvalidFileError(
      `Fichier en version ${String(file.version)}, alors que cette application lit la version ${FILE_VERSION}. ` +
        'Relancez une collecte, puis réexportez.',
    );
  }

  const dataset = emptyDataset();
  const authorIndex = Array.isArray(file.authorIndex) ? file.authorIndex : [];
  const projectIndex = Array.isArray(file.projectIndex) ? file.projectIndex : [];

  for (const project of file.projects ?? []) dataset.projects.set(project.key, project);
  for (const author of file.authors ?? []) dataset.authors.set(author.id, author);

  for (const row of file.daily ?? []) {
    // Garde d'entrée : le fichier est fait pour être partagé, donc éditable à la
    // main. Une ligne amputée n'est pas réparable, on l'écarte.
    if (!Array.isArray(row) || row.length !== 9) continue;
    const [projectIdx, authorIdx, day, commits, additions, deletions, merges, hourly, hourlyMerges] = row;
    const authorId = authorIndex[authorIdx];
    const key = projectIndex[projectIdx];
    if (authorId === undefined || key === undefined) continue;
    const bucket: DailyBucket = {
      key: `${key}|${authorId}|${day}`,
      projectKey: key,
      authorId,
      day,
      commits,
      additions,
      deletions,
      merges,
      hourly: sanitizeHours(hourly),
      hourlyMerges: sanitizeHours(hourlyMerges),
    };
    dataset.daily.set(bucket.key, bucket);
  }

  for (const overview of file.overviews ?? []) {
    dataset.overviews.set(overview.projectKey, overview);
  }
  for (const commit of file.recentCommits ?? []) dataset.recentCommits.set(commit.key, commit);

  dataset.meta = {
    instances: file.instances ?? [],
    window: file.window ?? null,
    lastSyncAt: file.generatedAt ?? null,
    config: { ...DEFAULT_SYNC_CONFIG, ...(file.config ?? {}) },
    manualAliases: file.manualAliases ?? {},
  };

  return dataset;
}

export function toJsonBlob(file: GitStatsFile): Blob {
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

/** Nom de fichier par défaut, daté pour ne pas écraser un export précédent. */
export function defaultFileName(label: string, now = new Date()): string {
  const slug = label.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-') || 'export';
  return `gitstats-${slug}-${now.toISOString().slice(0, 10)}.json`;
}

export function estimateFileSize(dataset: Dataset): number {
  // ~62 octets par ligne packée (55 + la répartition horaire creuse), plus les
  // métadonnées projets/auteurs.
  return dataset.daily.size * 62 + dataset.projects.size * 420 + dataset.recentCommits.size * 190;
}
