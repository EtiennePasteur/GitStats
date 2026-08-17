/**
 * Jeu de données en mémoire : source unique de vérité pour toute l'UI.
 *
 * IndexedDB assure la durabilité, mais on ne le relit pas à chaque rendu.
 * Le moteur de sync mute ce Dataset au fil de l'eau, ce qui permet aux
 * graphiques de se remplir pendant la collecte plutôt qu'à la fin.
 */

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
import * as db from './db';

export interface Dataset {
  projects: Map<ProjectKey, StoredProject>;
  authors: Map<string, StoredAuthor>;
  daily: Map<string, DailyBucket>;
  overviews: Map<ProjectKey, ProjectOverview>;
  recentCommits: Map<string, RecentCommit>;
  rhythms: Map<string, AuthorRhythm>;
  meta: StoredMeta | null;
}

export function emptyDataset(): Dataset {
  return {
    projects: new Map(),
    authors: new Map(),
    daily: new Map(),
    overviews: new Map(),
    recentCommits: new Map(),
    rhythms: new Map(),
    meta: null,
  };
}

export async function loadDataset(): Promise<Dataset> {
  const [projects, authors, daily, overviews, recentCommits, rhythms, meta] = await Promise.all([
    db.readProjects(),
    db.readAuthors(),
    db.readDaily(),
    db.readOverviews(),
    db.readRecentCommits(),
    db.readRhythms(),
    db.readMeta(),
  ]);

  return {
    projects: new Map(projects.map((project) => [project.key, project])),
    authors: new Map(authors.map((author) => [author.id, author])),
    daily: new Map(daily.map((bucket) => [bucket.key, bucket])),
    overviews: new Map(overviews.map((overview) => [overview.projectKey, overview])),
    recentCommits: new Map(recentCommits.map((commit) => [commit.key, commit])),
    rhythms: new Map(rhythms.map((rhythm) => [rhythm.authorId, rhythm])),
    meta: meta ?? null,
  };
}

/** Additionne un lot de seaux dans le Dataset (même sémantique que `mergeDaily`). */
export function mergeBucketsInMemory(dataset: Dataset, buckets: DailyBucket[]): void {
  for (const bucket of buckets) {
    const existing = dataset.daily.get(bucket.key);
    if (existing === undefined) {
      dataset.daily.set(bucket.key, { ...bucket });
    } else {
      existing.commits += bucket.commits;
      existing.additions += bucket.additions;
      existing.deletions += bucket.deletions;
      existing.merges += bucket.merges;
    }
  }
}

export function mergeRhythmsInMemory(dataset: Dataset, rhythms: AuthorRhythm[]): void {
  for (const rhythm of rhythms) {
    const existing = dataset.rhythms.get(rhythm.authorId);
    if (existing === undefined) {
      dataset.rhythms.set(rhythm.authorId, {
        authorId: rhythm.authorId,
        hours: [...rhythm.hours],
        weekdays: [...rhythm.weekdays],
      });
    } else {
      for (let i = 0; i < 24; i++) existing.hours[i] = (existing.hours[i] ?? 0) + (rhythm.hours[i] ?? 0);
      for (let i = 0; i < 7; i++) {
        existing.weekdays[i] = (existing.weekdays[i] ?? 0) + (rhythm.weekdays[i] ?? 0);
      }
    }
  }
}

/** Supprime toute trace d'un projet — préalable à un re-sync complet. */
export function resetProjectInMemory(dataset: Dataset, projectKey: ProjectKey): void {
  for (const [key, bucket] of dataset.daily) {
    if (bucket.projectKey === projectKey) dataset.daily.delete(key);
  }
  for (const [key, commit] of dataset.recentCommits) {
    if (commit.projectKey === projectKey) dataset.recentCommits.delete(key);
  }
  dataset.overviews.delete(projectKey);
}

/** Remplace intégralement le contenu d'IndexedDB (import d'un fichier .json). */
export async function persistWholeDataset(dataset: Dataset): Promise<void> {
  await db.clearAllData(true);
  await Promise.all([
    db.writeProjects([...dataset.projects.values()]),
    db.replaceAuthors([...dataset.authors.values()]),
    db.replaceDaily([...dataset.daily.values()]),
    db.replaceRecentCommits([...dataset.recentCommits.values()]),
    db.replaceRhythms([...dataset.rhythms.values()]),
  ]);
  for (const overview of dataset.overviews.values()) await db.writeOverview(overview);
  if (dataset.meta) await db.writeMeta(dataset.meta);
}
