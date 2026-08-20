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
  StoredMeta,
} from '../model/types';
import { cloneHours, mergeHours } from '../model/hours';
import { isBotIdentity, localPart, flattenAliases, resolveAuthorId } from '../sync/identity';
import { DEFAULT_SYNC_CONFIG } from '../model/types';
import * as db from './db';

export interface Dataset {
  projects: Map<ProjectKey, StoredProject>;
  authors: Map<string, StoredAuthor>;
  daily: Map<string, DailyBucket>;
  overviews: Map<ProjectKey, ProjectOverview>;
  recentCommits: Map<string, RecentCommit>;
  meta: StoredMeta | null;
}

export function emptyDataset(): Dataset {
  return {
    projects: new Map(),
    authors: new Map(),
    daily: new Map(),
    overviews: new Map(),
    recentCommits: new Map(),
    meta: null,
  };
}

export async function loadDataset(): Promise<Dataset> {
  const [projects, authors, daily, overviews, recentCommits, meta] = await Promise.all([
    db.readProjects(),
    db.readAuthors(),
    db.readDaily(),
    db.readOverviews(),
    db.readRecentCommits(),
    db.readMeta(),
  ]);

  const dataset: Dataset = {
    projects: new Map(projects.map((project) => [project.key, project])),
    authors: new Map(authors.map((author) => [author.id, author])),
    daily: new Map(daily.map((bucket) => [bucket.key, bucket])),
    overviews: new Map(overviews.map((overview) => [overview.projectKey, overview])),
    recentCommits: new Map(recentCommits.map((commit) => [commit.key, commit])),
    meta: meta ?? null,
  };
  recoverManualAliases(dataset);
  reconcileAuthors(dataset);
  return dataset;
}

/**
 * Rétablit dans `manualAliases` les fusions que seules les fiches portent encore,
 * et renvoie le nombre d'alias récupérés.
 *
 * Une fiche ne porte plusieurs `identityKeys` que par décision manuelle :
 * `observe()` n'unit jamais deux adresses, seul le rejeu de `manualAliases` le
 * fait. Quand la fiche est fusionnée mais que l'alias a disparu, la fusion
 * devient **ingérable** : la fiche de la personne liste bien ses deux adresses,
 * mais les réglages n'affichent que `manualAliases` — donc aucune ligne, aucun
 * bouton « Annuler ». Et depuis que le sync ne refige plus les fiches, un
 * prochain passage dé-fusionnerait la personne sans que rien ne l'ait demandé.
 *
 * On reconstitue donc l'alias plutôt que de trancher à la place de l'utilisateur :
 * la décision redevient visible, et réversible d'un clic.
 */
export function recoverManualAliases(dataset: Dataset): number {
  const meta = dataset.meta;
  if (meta === null) return 0;

  const aliases = { ...meta.manualAliases };
  let recovered = 0;
  for (const author of dataset.authors.values()) {
    for (const key of author.identityKeys) {
      // Un alias déjà présent fait foi : il reste la source de vérité, même s'il
      // désigne une autre cible que cette fiche.
      if (key === author.id || aliases[key] !== undefined) continue;
      aliases[key] = author.id;
      recovered += 1;
    }
  }
  if (recovered > 0) meta.manualAliases = aliases;
  return recovered;
}

/**
 * Réaligne les fiches sur les alias, en détachant les identités qu'aucun alias
 * ne justifie plus. Renvoie les clés détachées.
 *
 * À appeler dès que `manualAliases` change, sinon « Annuler » reste à moitié
 * appliqué : l'alias disparaît, mais la fiche garde les deux adresses jusqu'au
 * prochain sync — et `recoverManualAliases` en déduirait au rechargement suivant
 * qu'il faut rétablir l'alias, annulant l'annulation.
 *
 * Ne fusionne rien, uniquement l'inverse : appliquer une fusion est déjà résolu
 * à la lecture par `mergeAuthorRecords`, sans toucher au stockage.
 */
export function alignAuthorsToAliases(dataset: Dataset): string[] {
  const flat = flattenAliases(dataset.meta?.manualAliases ?? {});
  const detached: string[] = [];

  for (const author of dataset.authors.values()) {
    const kept: string[] = [];
    for (const key of author.identityKeys) {
      if (key === author.id || resolveAuthorId(key, flat) === author.id) kept.push(key);
      else detached.push(key);
    }
    if (kept.length === author.identityKeys.length) continue;
    author.identityKeys = kept.length > 0 ? kept : [author.id];
    // La fiche ne résulte plus d'une décision manuelle.
    if (author.identityKeys.length === 1) author.manual = undefined;
  }

  // Une identité détachée redevient une personne : `reconcileAuthors` lui recrée
  // une fiche à partir des seaux qui la citent encore.
  if (detached.length > 0) reconcileAuthors(dataset);
  return detached;
}

/**
 * Recrée une fiche minimale pour toute personne citée par les données mais
 * absente de la table des auteurs, et renvoie le nombre de fiches ajoutées.
 *
 * Un `authorId` orphelin n'est pas une donnée perdue mais une donnée muette :
 * les seaux comptent toujours ses commits, seulement plus rien ne sait la
 * nommer (`authorName` retombe sur l'adresse brute), la reconnaître comme robot
 * (`filters.excludeBots` teste `author.isBot`) ni la proposer en fusion
 * (`suggestMerges` n'itère que sur les fiches).
 *
 * Ne remplace pas une collecte : les variantes de noms croisées dans les commits
 * ne sont, elles, récupérables qu'auprès de GitLab.
 */
export function reconcileAuthors(dataset: Dataset): number {
  const botPatterns = dataset.meta?.config.botPatterns ?? DEFAULT_SYNC_CONFIG.botPatterns;

  const restore = (authorId: string): void => {
    if (authorId === '' || dataset.authors.has(authorId)) return;
    // `id` est la clé d'identité normalisée, donc l'adresse elle-même dans le cas
    // courant : le nom d'affichage se réduit à sa partie locale, comme le fait
    // `toAuthors()` quand aucun nom n'a été observé.
    const displayName = localPart(authorId);
    dataset.authors.set(authorId, {
      id: authorId,
      displayName,
      primaryEmail: authorId,
      identityKeys: [authorId],
      knownNames: [],
      knownEmails: [],
      isBot: isBotIdentity({ name: displayName, email: authorId }, botPatterns),
    });
  };

  const before = dataset.authors.size;
  for (const bucket of dataset.daily.values()) restore(bucket.authorId);
  // Les aperçus de la vague 1 citent des personnes qui n'ont pas forcément de
  // seau dans la fenêtre de dates collectée.
  for (const overview of dataset.overviews.values()) {
    for (const entry of overview.entries) restore(entry.authorId);
  }
  for (const commit of dataset.recentCommits.values()) restore(commit.authorId);
  return dataset.authors.size - before;
}

/**
 * Additionne un lot de seaux dans le Dataset.
 *
 * Doit rester d'accord au nombre près avec `db.mergeDaily` : c'est la même
 * fusion, l'une en mémoire et l'autre en base. Si les deux divergeaient, les
 * chiffres changeraient au simple rechargement de l'onglet.
 */
export function mergeBucketsInMemory(dataset: Dataset, buckets: DailyBucket[]): void {
  for (const bucket of buckets) {
    const existing = dataset.daily.get(bucket.key);
    if (existing === undefined) {
      // `{ ...bucket }` est une copie SUPERFICIELLE : sans clone explicite, les
      // tableaux d'heures resteraient partagés avec le résultat d'ingestion.
      dataset.daily.set(bucket.key, {
        ...bucket,
        hourly: cloneHours(bucket.hourly),
        hourlyMerges: cloneHours(bucket.hourlyMerges),
      });
    } else {
      existing.commits += bucket.commits;
      existing.additions += bucket.additions;
      existing.deletions += bucket.deletions;
      existing.merges += bucket.merges;
      existing.hourly = mergeHours(existing.hourly, bucket.hourly);
      existing.hourlyMerges = mergeHours(existing.hourlyMerges, bucket.hourlyMerges);
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
  ]);
  for (const overview of dataset.overviews.values()) await db.writeOverview(overview);
  if (dataset.meta) await db.writeMeta(dataset.meta);
}
