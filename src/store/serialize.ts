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
import { migrateV1ToV2, type V1Snapshot } from './migrate';
import type { Dataset } from './dataset';
import { emptyDataset } from './dataset';

export const FILE_FORMAT = 'gitstats';
export const FILE_VERSION = 2;

/**
 * `[projectIndex, authorIndex, day, commits, additions, deletions, merges,
 *   hourly?, hourlyMerges?]`
 *
 * Les clés de projet sont désormais des chaînes (`instance~42`) : les indexer
 * comme les auteurs évite de répéter le nom de l'instance sur chacune des
 * dizaines de milliers de lignes.
 *
 * Les deux derniers éléments sont OMIS quand le seau ne porte pas d'heures : une
 * ligne de longueur 7 signifie « heure inconnue », et c'est ce qui fait survivre
 * le marqueur de couverture à l'aller-retour fichier. Les émettre à vide ferait
 * mentir la carte « Rythme de travail » après un export/import.
 */
type PackedDaily = [number, number, string, number, number, number, number, number[]?, number[]?];
/**
 * `[authorIndex, heures[24], joursSemaine[7]]`
 * @deprecated Voir `AuthorRhythm`. Toujours émis à vide pour qu'un fichier neuf
 * reste lisible par une version antérieure de l'application.
 */
type PackedRhythm = [number, number[], number[]];

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
  rhythms: PackedRhythm[];
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
    const row: PackedDaily = [
      resolveProject(bucket.projectKey),
      resolveIndex(bucket.authorId),
      bucket.day,
      bucket.commits,
      bucket.additions,
      bucket.deletions,
      bucket.merges,
    ];
    // `hourlyMerges` sans `hourly` est impossible par construction : pas de trou
    // à combler, la ligne s'arrête simplement plus tôt.
    if (bucket.hourly !== undefined) {
      row.push(bucket.hourly);
      if (bucket.hourlyMerges !== undefined) row.push(bucket.hourlyMerges);
    }
    daily.push(row);
  }

  const rhythms: PackedRhythm[] = [];

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
    rhythms,
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
  if (typeof file.version !== 'number' || file.version > FILE_VERSION) {
    throw new InvalidFileError(
      `Fichier en version ${String(file.version)}, incompatible avec cette version de l'app (${FILE_VERSION}).`,
    );
  }

  // Un fichier v1 est mono-instance : on le convertit avec la même
  // transformation que la base locale, plutôt que de le refuser.
  const normalized = file.version === 1 ? upgradeV1File(file) : file;

  const dataset = emptyDataset();
  const authorIndex = Array.isArray(normalized.authorIndex) ? normalized.authorIndex : [];
  const projectIndex = Array.isArray(normalized.projectIndex) ? normalized.projectIndex : [];

  for (const project of normalized.projects ?? []) dataset.projects.set(project.key, project);
  for (const author of normalized.authors ?? []) dataset.authors.set(author.id, author);

  for (const row of normalized.daily ?? []) {
    // Une ligne de 7 éléments vient d'une version antérieure : elle reste lisible,
    // simplement sans heures.
    if (!Array.isArray(row) || row.length < 7) continue;
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

  for (const overview of normalized.overviews ?? []) {
    dataset.overviews.set(overview.projectKey, overview);
  }
  for (const commit of normalized.recentCommits ?? []) dataset.recentCommits.set(commit.key, commit);

  dataset.meta = {
    schemaVersion: FILE_VERSION,
    instances: normalized.instances ?? [],
    window: normalized.window ?? null,
    lastSyncAt: normalized.generatedAt ?? null,
    config: { ...DEFAULT_SYNC_CONFIG, ...(normalized.config ?? {}) },
    manualAliases: normalized.manualAliases ?? {},
  };

  return dataset;
}

/**
 * Convertit un fichier v1 (mono-instance) au format v2.
 * Réutilise `migrateV1ToV2` pour que fichier et base locale suivent exactement
 * la même règle de rattachement à l'instance d'origine.
 */
function upgradeV1File(file: Partial<GitStatsFile>): Partial<GitStatsFile> {
  const legacy = file as unknown as {
    gitlabHost?: string;
    projects?: Array<{ id: number } & Record<string, unknown>>;
    daily?: Array<[number, number, string, number, number, number, number]>;
    overviews?: Array<{ projectId: number } & Record<string, unknown>>;
    recentCommits?: Array<{ projectId: number; sha: string } & Record<string, unknown>>;
    authorIndex?: string[];
  };
  const authorIndex = legacy.authorIndex ?? [];

  const snapshot = {
    projects: (legacy.projects ?? []) as unknown as V1Snapshot['projects'],
    // Les lignes packées sont dépliées le temps de la conversion : elles portent
    // un index d'auteur, pas son identifiant.
    daily: (legacy.daily ?? []).map((row) => ({
      key: '',
      projectId: row[0],
      authorId: authorIndex[row[1]] ?? '',
      day: row[2],
      commits: row[3],
      additions: row[4],
      deletions: row[5],
      merges: row[6],
    })) as unknown as V1Snapshot['daily'],
    overviews: (legacy.overviews ?? []) as unknown as V1Snapshot['overviews'],
    recentCommits: (legacy.recentCommits ?? []) as unknown as V1Snapshot['recentCommits'],
    meta: { host: legacy.gitlabHost, config: file.config } as V1Snapshot['meta'],
  };

  const migrated = migrateV1ToV2(snapshot, new Date().toISOString());
  const projectIndex = [...new Set(migrated.projects.map((project) => project.key))];
  const projectIndexOf = new Map(projectIndex.map((key, i) => [key, i]));
  const authorIndexOf = new Map(authorIndex.map((id, i) => [id, i]));

  return {
    ...file,
    version: FILE_VERSION,
    instances: [migrated.instance],
    projects: migrated.projects,
    overviews: migrated.overviews,
    recentCommits: migrated.recentCommits,
    projectIndex,
    daily: migrated.daily.map((bucket) => [
      projectIndexOf.get(bucket.projectKey) ?? 0,
      authorIndexOf.get(bucket.authorId) ?? 0,
      bucket.day,
      bucket.commits,
      bucket.additions,
      bucket.deletions,
      bucket.merges,
    ]) as GitStatsFile['daily'],
  };
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
