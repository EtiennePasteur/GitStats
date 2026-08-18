/**
 * Couche de requête : filtrage et agrégation des seaux journaliers.
 *
 * Tout se fait en mémoire sur des tableaux plats. Sur un parc de 234 dépôts,
 * l'ordre de grandeur est de 10⁴–10⁵ seaux : un simple balayage tient largement
 * sous les 100 ms visés pour une interaction de filtre, sans indexation exotique.
 *
 * Aucun import React : ces fonctions sont pures et testables isolément.
 */

import type { DailyBucket, StoredAuthor, StoredProject, ProjectKey } from '../model/types';
import { instanceOfProject } from '../model/types';

export interface Filters {
  /** Bornes incluses, `YYYY-MM-DD`. `null` = pas de borne. */
  from: string | null;
  to: string | null;
  projectKeys: ReadonlySet<ProjectKey> | null;
  /** `null` = toutes les instances. Ignoré s'il n'y en a qu'une. */
  instanceIds: ReadonlySet<string> | null;
  authorIds: ReadonlySet<string> | null;
  /** Chemins de groupes GitLab, ex. `backend/api`. Préfixes inclusifs. */
  namespaces: ReadonlySet<string> | null;
  excludeBots: boolean;
  excludeMerges: boolean;
  /** Filtre texte sur le nom du projet. */
  search: string;
}

export const EMPTY_FILTERS: Filters = {
  from: null,
  to: null,
  projectKeys: null,
  instanceIds: null,
  authorIds: null,
  namespaces: null,
  excludeBots: true,
  excludeMerges: false,
  search: '',
};

export interface Totals {
  commits: number;
  additions: number;
  deletions: number;
  merges: number;
  activeAuthors: number;
  activeProjects: number;
  activeDays: number;
}

export interface AuthorStats {
  authorId: string;
  commits: number;
  additions: number;
  deletions: number;
  merges: number;
  projectKeys: Set<ProjectKey>;
  activeDays: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface ProjectStats {
  projectKey: ProjectKey;
  commits: number;
  additions: number;
  deletions: number;
  merges: number;
  authorIds: Set<string>;
  activeDays: number;
  lastDay: string | null;
}

export interface DayPoint {
  day: string;
  commits: number;
  additions: number;
  deletions: number;
}

/**
 * Applique les filtres. `commits` est déjà net des merges si `excludeMerges`.
 *
 * Les lignes ne sont jamais affectées par `excludeMerges` : elles excluent
 * les merges en permanence, dès l'ingestion (un merge renvoie le diff complet
 * de la branche, déjà comptabilisé). Voir `sync/aggregate.ts`.
 */
export function filterBuckets(
  buckets: Iterable<DailyBucket>,
  filters: Filters,
  authors: ReadonlyMap<string, StoredAuthor>,
  projects: ReadonlyMap<ProjectKey, StoredProject>,
  /**
   * Fusions d'identités, appliquées à la LECTURE.
   *
   * Les seaux stockés conservent l'identifiant d'origine : une fusion se voit
   * donc immédiatement, sans re-synchroniser, et reste annulable. Réécrire les
   * seaux serait irréversible sans une collecte complète.
   */
  aliases?: ReadonlyMap<string, string>,
): DailyBucket[] {
  const namespaces = filters.namespaces;
  const search = filters.search.trim().toLowerCase();
  const result: DailyBucket[] = [];

  for (const bucket of buckets) {
    if (filters.from !== null && bucket.day < filters.from) continue;
    if (filters.to !== null && bucket.day > filters.to) continue;
    if (filters.projectKeys !== null && !filters.projectKeys.has(bucket.projectKey)) continue;
    if (filters.instanceIds !== null && !filters.instanceIds.has(instanceOfProject(bucket.projectKey))) {
      continue;
    }

    // La résolution précède les filtres par auteur : sélectionner une personne
    // fusionnée doit ramener les commits de TOUTES ses adresses.
    const authorId = aliases?.get(bucket.authorId) ?? bucket.authorId;
    if (filters.authorIds !== null && !filters.authorIds.has(authorId)) continue;

    if (filters.excludeBots) {
      const author = authors.get(authorId);
      if (author?.isBot === true) continue;
    }

    const project = projects.get(bucket.projectKey);
    // Un dépôt écarté (miroir d'une autre instance, par exemple) ne compte nulle part.
    if (project?.excluded === true) continue;
    if (namespaces !== null || search !== '') {
      if (project === undefined) continue;
      if (namespaces !== null && !matchesNamespace(project.namespaceFullPath, namespaces)) continue;
      if (search !== '' && !project.pathWithNamespace.toLowerCase().includes(search)) continue;
    }

    const renamed = authorId !== bucket.authorId;
    if (filters.excludeMerges) {
      const net = bucket.commits - bucket.merges;
      if (net <= 0) continue;
      result.push({ ...bucket, authorId, commits: net, merges: 0 });
    } else if (renamed) {
      // Copie : les seaux d'origine appartiennent au Dataset partagé et ne
      // doivent jamais être mutés par une lecture.
      result.push({ ...bucket, authorId });
    } else {
      result.push(bucket);
    }
  }
  return result;
}

/** Un groupe sélectionné inclut ses sous-groupes (`backend` couvre `backend/api`). */
function matchesNamespace(fullPath: string, selected: ReadonlySet<string>): boolean {
  if (selected.has(fullPath)) return true;
  for (const candidate of selected) {
    if (fullPath.startsWith(`${candidate}/`)) return true;
  }
  return false;
}

export function computeTotals(buckets: readonly DailyBucket[]): Totals {
  let commits = 0;
  let additions = 0;
  let deletions = 0;
  let merges = 0;
  const authors = new Set<string>();
  const projects = new Set<ProjectKey>();
  const days = new Set<string>();

  for (const bucket of buckets) {
    commits += bucket.commits;
    additions += bucket.additions;
    deletions += bucket.deletions;
    merges += bucket.merges;
    authors.add(bucket.authorId);
    projects.add(bucket.projectKey);
    days.add(bucket.day);
  }

  return {
    commits,
    additions,
    deletions,
    merges,
    activeAuthors: authors.size,
    activeProjects: projects.size,
    activeDays: days.size,
  };
}

/**
 * ⚠️ `activeDays` compte les jours DISTINCTS, pas les seaux.
 *
 * Il y a un seau par (projet, auteur, jour) : quelqu'un qui touche 5 dépôts le
 * même jour produit 5 seaux pour une seule journée de travail. Additionner les
 * seaux donnerait 1 796 « jours actifs » sur une fenêtre de 365 jours, et
 * fausserait au passage tout ratio « commits par jour actif ».
 */
export function byAuthor(buckets: readonly DailyBucket[]): AuthorStats[] {
  const map = new Map<string, AuthorStats>();
  const daysSeen = new Map<string, Set<string>>();

  for (const bucket of buckets) {
    let entry = map.get(bucket.authorId);
    if (entry === undefined) {
      entry = {
        authorId: bucket.authorId,
        commits: 0,
        additions: 0,
        deletions: 0,
        merges: 0,
        projectKeys: new Set(),
        activeDays: 0,
        firstDay: null,
        lastDay: null,
      };
      map.set(bucket.authorId, entry);
      daysSeen.set(bucket.authorId, new Set());
    }
    entry.commits += bucket.commits;
    entry.additions += bucket.additions;
    entry.deletions += bucket.deletions;
    entry.merges += bucket.merges;
    entry.projectKeys.add(bucket.projectKey);
    daysSeen.get(bucket.authorId)!.add(bucket.day);
    if (entry.firstDay === null || bucket.day < entry.firstDay) entry.firstDay = bucket.day;
    if (entry.lastDay === null || bucket.day > entry.lastDay) entry.lastDay = bucket.day;
  }

  for (const [authorId, days] of daysSeen) map.get(authorId)!.activeDays = days.size;
  return [...map.values()].sort((a, b) => b.commits - a.commits);
}

/** Même règle que `byAuthor` : `activeDays` = jours distincts. */
export function byProject(buckets: readonly DailyBucket[]): ProjectStats[] {
  const map = new Map<ProjectKey, ProjectStats>();
  const daysSeen = new Map<ProjectKey, Set<string>>();

  for (const bucket of buckets) {
    let entry = map.get(bucket.projectKey);
    if (entry === undefined) {
      entry = {
        projectKey: bucket.projectKey,
        commits: 0,
        additions: 0,
        deletions: 0,
        merges: 0,
        authorIds: new Set(),
        activeDays: 0,
        lastDay: null,
      };
      map.set(bucket.projectKey, entry);
      daysSeen.set(bucket.projectKey, new Set());
    }
    entry.commits += bucket.commits;
    entry.additions += bucket.additions;
    entry.deletions += bucket.deletions;
    entry.merges += bucket.merges;
    entry.authorIds.add(bucket.authorId);
    daysSeen.get(bucket.projectKey)!.add(bucket.day);
    if (entry.lastDay === null || bucket.day > entry.lastDay) entry.lastDay = bucket.day;
  }

  for (const [key, days] of daysSeen) map.get(key)!.activeDays = days.size;
  return [...map.values()].sort((a, b) => b.commits - a.commits);
}

/** Série temporelle, jours vides compris (sinon les graphes mentent sur les creux). */
export function byDay(buckets: readonly DailyBucket[], from?: string, to?: string): DayPoint[] {
  const map = new Map<string, DayPoint>();
  let min: string | null = from ?? null;
  let max: string | null = to ?? null;

  for (const bucket of buckets) {
    let point = map.get(bucket.day);
    if (point === undefined) {
      point = { day: bucket.day, commits: 0, additions: 0, deletions: 0 };
      map.set(bucket.day, point);
    }
    point.commits += bucket.commits;
    point.additions += bucket.additions;
    point.deletions += bucket.deletions;
    if (from === undefined && (min === null || bucket.day < min)) min = bucket.day;
    if (to === undefined && (max === null || bucket.day > max)) max = bucket.day;
  }

  if (min === null || max === null) return [];
  return fillDays(min, max).map(
    (day) => map.get(day) ?? { day, commits: 0, additions: 0, deletions: 0 },
  );
}

/**
 * Séries empilées : une par entité nommée, plus « Autres ».
 *
 * « Autres » est renvoyé EN PREMIER pour se retrouver au bas de la pile. Placée
 * au sommet, cette bande — souvent la plus épaisse puisqu'elle agrège toute la
 * longue traîne — écrase visuellement les séries nommées et rend le graphique
 * inutilisable.
 */
export function byDayAndAuthor(
  buckets: readonly DailyBucket[],
  namedAuthorIds: readonly string[],
  options: { from?: string; to?: string; granularity?: Granularity } = {},
): { days: string[]; series: Array<{ authorId: string; values: number[] }>; granularity: Granularity } {
  const { from, to } = options;
  const named = new Set(namedAuthorIds);
  let min: string | null = from ?? null;
  let max: string | null = to ?? null;

  for (const bucket of buckets) {
    if (from === undefined && (min === null || bucket.day < min)) min = bucket.day;
    if (to === undefined && (max === null || bucket.day > max)) max = bucket.day;
  }
  if (min === null || max === null) return { days: [], series: [], granularity: 'day' };

  const allDays = fillDays(min, max);
  const granularity = options.granularity ?? pickGranularity(allDays.length);

  const allBuckets: string[] = [];
  for (const day of allDays) {
    const key = bucketOfDay(day, granularity);
    if (allBuckets[allBuckets.length - 1] !== key) allBuckets.push(key);
  }

  // Mêmes seaux de bord partiels que pour les séries simples : les retirer évite
  // la fausse chute d'activité aux deux extrémités de la courbe.
  const edges = allBuckets.length >= 3 ? partialEdges(allDays, granularity) : { first: false, last: false };
  const days = allBuckets.slice(
    edges.first ? 1 : 0,
    edges.last ? allBuckets.length - 1 : allBuckets.length,
  );

  const dayIndex = new Map<string, number>();
  days.forEach((day, index) => dayIndex.set(day, index));

  const series = new Map<string, number[]>();
  const ensure = (id: string) => {
    let values = series.get(id);
    if (values === undefined) {
      values = new Array<number>(days.length).fill(0);
      series.set(id, values);
    }
    return values;
  };
  for (const id of namedAuthorIds) ensure(id);

  let hasOthers = false;
  for (const bucket of buckets) {
    const index = dayIndex.get(bucketOfDay(bucket.day, granularity));
    if (index === undefined) continue;
    const key = named.has(bucket.authorId) ? bucket.authorId : OTHER_SERIES_ID;
    if (key === OTHER_SERIES_ID) hasOthers = true;
    const values = ensure(key);
    values[index] = (values[index] ?? 0) + bucket.commits;
  }

  const namedSeries = namedAuthorIds.map((authorId) => ({ authorId, values: ensure(authorId) }));
  return {
    days,
    series: hasOthers
      ? [{ authorId: OTHER_SERIES_ID, values: ensure(OTHER_SERIES_ID) }, ...namedSeries]
      : namedSeries,
    granularity,
  };
}

export const OTHER_SERIES_ID = '__other__';

export type Granularity = 'day' | 'week' | 'month';

/**
 * Choisit le pas temporel d'affichage.
 *
 * Tracer 365 points journaliers sur 1 400 px donne un peigne : le lecteur voit
 * du bruit quotidien là où il cherche une tendance. On regroupe donc au-delà
 * d'un certain étalement. Le stockage, lui, reste journalier — c'est une
 * décision d'affichage, pas de collecte.
 */
export function pickGranularity(dayCount: number): Granularity {
  if (dayCount <= 92) return 'day';
  if (dayCount <= 550) return 'week';
  return 'month';
}

/** Étiquette du seau d'agrégation auquel appartient un jour. */
export function bucketOfDay(day: string, granularity: Granularity): string {
  if (granularity === 'day') return day;
  if (granularity === 'month') return `${day.slice(0, 7)}-01`;
  // Semaine ISO : on ramène au lundi précédent.
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // 0 = lundi
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

/** Dernier jour couvert par le seau d'agrégation qui commence à `start`. */
function bucketEnd(start: string, granularity: Granularity): string {
  const date = new Date(`${start}T00:00:00Z`);
  if (granularity === 'week') date.setUTCDate(date.getUTCDate() + 6);
  else if (granularity === 'month') {
    date.setUTCMonth(date.getUTCMonth() + 1);
    date.setUTCDate(0);
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Indique si les seaux de bord sont incomplets.
 *
 * Une fenêtre « 12 mois » commence et finit rarement un lundi : le premier et le
 * dernier seau hebdomadaire ne contiennent alors que 2 ou 3 jours. Tracés tels
 * quels, ils dessinent une chute vertigineuse à chaque extrémité de la courbe,
 * que le lecteur interprète comme un effondrement d'activité alors qu'il ne
 * s'agit que d'un artefact de découpage.
 */
export function partialEdges(
  days: string[],
  granularity: Granularity,
): { first: boolean; last: boolean } {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined || granularity === 'day') {
    return { first: false, last: false };
  }
  return {
    first: bucketOfDay(first, granularity) !== first,
    last: bucketEnd(bucketOfDay(last, granularity), granularity) !== last,
  };
}

/**
 * Regroupe une série journalière au pas demandé.
 *
 * `trimPartialEdges` retire les seaux de bord incomplets (voir `partialEdges`).
 * À n'utiliser que pour l'AFFICHAGE : les totaux et les tableaux, eux, doivent
 * continuer à compter toutes les journées.
 */
export function aggregateByGranularity(
  points: DayPoint[],
  granularity: Granularity,
  options: { trimPartialEdges?: boolean } = {},
): DayPoint[] {
  if (granularity === 'day') return points;
  const map = new Map<string, DayPoint>();
  for (const point of points) {
    const key = bucketOfDay(point.day, granularity);
    let entry = map.get(key);
    if (entry === undefined) {
      entry = { day: key, commits: 0, additions: 0, deletions: 0 };
      map.set(key, entry);
    }
    entry.commits += point.commits;
    entry.additions += point.additions;
    entry.deletions += point.deletions;
  }
  const result = [...map.values()].sort((a, b) => a.day.localeCompare(b.day));

  if (options.trimPartialEdges !== true || result.length < 3) return result;
  const edges = partialEdges(
    points.map((point) => point.day),
    granularity,
  );
  return result.slice(edges.first ? 1 : 0, edges.last ? result.length - 1 : result.length);
}

/** Toutes les dates de `from` à `to` incluses. */
export function fillDays(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return days;
  // Garde-fou : une plage aberrante ne doit pas figer l'onglet.
  let guard = 0;
  while (cursor <= end && guard < 20_000) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return days;
}

/** Arborescence des groupes GitLab, pour le filtre par namespace. */
export function namespaceTree(projects: Iterable<StoredProject>): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const segments = project.namespaceFullPath.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const path = segments.slice(0, i).join('/');
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Fenêtre à tracer sur les axes temporels : bornes du filtre, rognées sur
 * l'étendue des données.
 *
 * Les axes doivent suivre la période choisie — sinon changer de préréglage ne
 * bouge rien à l'écran, les données filtrées se tassant dans un axe resté
 * all-time. Le rognage évite le symétrique : « 12 derniers mois » sur un parc
 * qui n'a que 3 mois d'historique dessinerait 9 mois de vide, que le lecteur
 * lirait comme une absence d'activité et non comme une absence de données.
 *
 * Renvoie `null, null` si l'intersection est vide (période hors données).
 */
export function visibleRange(
  filters: { from: string | null; to: string | null },
  extent: { from: string | null; to: string | null },
): { from: string | null; to: string | null } {
  if (extent.from === null || extent.to === null) return { from: null, to: null };
  const from = filters.from !== null && filters.from > extent.from ? filters.from : extent.from;
  const to = filters.to !== null && filters.to < extent.to ? filters.to : extent.to;
  return from > to ? { from: null, to: null } : { from, to };
}

/** Bornes de dates réellement couvertes par les données. */
export function dataExtent(buckets: Iterable<DailyBucket>): { from: string | null; to: string | null } {
  let from: string | null = null;
  let to: string | null = null;
  for (const bucket of buckets) {
    if (from === null || bucket.day < from) from = bucket.day;
    if (to === null || bucket.day > to) to = bucket.day;
  }
  return { from, to };
}
