/**
 * Pont entre le Dataset brut et les vues : applique les filtres une seule fois
 * par rendu et mémoïse les agrégats.
 *
 * Point clé sur les couleurs : l'attribution des teintes est calculée sur le
 * classement NON filtré (hors dates/bots/merges). Une personne conserve donc sa
 * couleur quand on change la plage de dates — c'est la règle « la couleur suit
 * l'entité, pas son rang ».
 */

import { useCallback, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useFilterStore, toFilters } from '../store/useFilterStore';
import { disambiguateLabels } from './labels';
import {
  filterBuckets,
  computeTotals,
  byAuthor,
  byProject,
  dataExtent,
  visibleRange,
  namespaceTree,
  type Filters,
  type AuthorStats,
  type ProjectStats,
  type Totals,
} from './selectors';
import { assignColors, readPalette, type ColorAssignment, type Palette } from '../viz/palette';
import { flattenAliases, mergeAuthorRecords } from '../sync/identity';
import type { DailyBucket, StoredAuthor, StoredProject, ProjectKey } from '../model/types';

export interface Analytics {
  buckets: DailyBucket[];
  totals: Totals;
  authors: AuthorStats[];
  projects: ProjectStats[];
  authorsById: ReadonlyMap<string, StoredAuthor>;
  projectsById: ReadonlyMap<ProjectKey, StoredProject>;
  /** Étendue TOTALE des données, indépendante des filtres. */
  extent: { from: string | null; to: string | null };
  /** Fenêtre affichée : `extent` restreint à la période sélectionnée. */
  range: { from: string | null; to: string | null };
  namespaces: Array<{ path: string; count: number }>;
  palette: Palette;
  /** Attribution stable des couleurs d'auteur (indépendante des filtres). */
  authorColors: ColorAssignment;
  /** Nom d'une personne, complété de son e-mail si un homonyme existe. */
  labelOf: (id: string) => string;
  /**
   * Identifiant d'ingestion → identifiant canonique après fusion manuelle.
   *
   * `filterBuckets` le fait déjà pour les seaux ; c'est pour les enregistrements
   * qui ne passent pas par lui, comme les commits récents, dont la couleur et le
   * libellé seraient sinon ceux d'une identité absorbée.
   */
  resolveAuthorId: (id: string) => string;
  isEmpty: boolean;
}

/**
 * `includeMuted` force la prise en compte des dépôts retirés des statistiques.
 * Réservé aux vues qui ne parlent QUE d'un dépôt : sur une fiche, ses chiffres
 * doivent rester lisibles, et le périmètre étant unique aucun total ne peut être
 * gonflé. Toute vue agrégée doit s'en tenir à l'interrupteur de la barre.
 */
export function useAnalytics(options?: { includeMuted?: boolean }): Analytics {
  const dataset = useAppStore((state) => state.dataset);
  const dataVersion = useAppStore((state) => state.dataVersion);
  const filterState = useFilterStore();
  const base = toFilters(filterState);
  const filters: Filters =
    options?.includeMuted === true ? { ...base, excludeMuted: false } : base;

  const palette = useMemo(() => readPalette(), []);

  /**
   * Fusions manuelles, résolues à la lecture : une fusion validée dans les
   * réglages se voit tout de suite, sans attendre la prochaine collecte, et
   * reste annulable puisque les seaux stockés ne sont pas réécrits.
   */
  const aliases = useMemo(
    () => flattenAliases(dataset.meta?.manualAliases ?? {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, dataVersion],
  );

  const mergedAuthors = useMemo(
    () => (aliases.size === 0 ? dataset.authors : mergeAuthorRecords(dataset.authors.values(), aliases)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, dataVersion, aliases],
  );

  // Étendue et arborescence de groupes : dépendent des données, pas des filtres.
  const extent = useMemo(
    () => dataExtent(dataset.daily.values()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, dataVersion],
  );
  // `extent` sert d'ancrage aux préréglages de la barre de filtres ; `range`
  // sert aux axes, qui doivent eux suivre la période sélectionnée.
  const range = useMemo(
    () => visibleRange({ from: filters.from, to: filters.to }, extent),
    [filters.from, filters.to, extent],
  );
  const namespaces = useMemo(
    () => namespaceTree(dataset.projects.values()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, dataVersion],
  );

  /**
   * Classement de référence pour les couleurs : volumes bruts, sans aucun filtre
   * de date. Seule l'exclusion des bots est prise en compte, car un bot ne doit
   * jamais consommer un des 8 emplacements catégoriels.
   */
  const authorColors = useMemo(() => {
    const totalsByAuthor = new Map<string, number>();
    for (const bucket of dataset.daily.values()) {
      const authorId = aliases.get(bucket.authorId) ?? bucket.authorId;
      const author = mergedAuthors.get(authorId);
      if (author?.isBot === true) continue;
      totalsByAuthor.set(authorId, (totalsByAuthor.get(authorId) ?? 0) + bucket.commits);
    }
    const ranked = [...totalsByAuthor.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id]) => id);
    return assignColors(ranked, palette);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, dataVersion, palette, aliases, mergedAuthors]);

  /**
   * Étiquettes désambiguïsées, calculées sur TOUTES les personnes connues et non
   * sur le périmètre filtré — même raisonnement que pour les couleurs : le nom
   * affiché d'une personne ne doit pas changer parce qu'un filtre a fait
   * disparaître son homonyme. Une légende ECharts étant indexée par le nom de
   * série, deux homonymes s'y replieraient sinon sur une seule entrée.
   */
  const authorLabels = useMemo(
    () =>
      disambiguateLabels(
        [...mergedAuthors.values()].map((author) => ({
          id: author.id,
          name: author.displayName,
          hint: author.primaryEmail,
        })),
      ),
    [mergedAuthors],
  );
  const labelOf = useCallback(
    (id: string) => authorLabels.get(id) ?? authorName(mergedAuthors, id),
    [authorLabels, mergedAuthors],
  );
  const resolveAuthorId = useCallback((id: string) => aliases.get(id) ?? id, [aliases]);

  const buckets = useMemo(
    () => filterBuckets(dataset.daily.values(), filters, mergedAuthors, dataset.projects, aliases),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      dataset,
      dataVersion,
      filters.from,
      filters.to,
      filters.projectKeys,
      filters.instanceIds,
      filters.authorIds,
      filters.namespaces,
      filters.excludeBots,
      filters.excludeMerges,
      filters.excludeMuted,
      filters.search,
      aliases,
      mergedAuthors,
    ],
  );

  const totals = useMemo(() => computeTotals(buckets), [buckets]);
  const authors = useMemo(() => byAuthor(buckets), [buckets]);
  const projects = useMemo(() => byProject(buckets), [buckets]);

  return {
    buckets,
    totals,
    authors,
    projects,
    authorsById: mergedAuthors,
    projectsById: dataset.projects,
    extent,
    range,
    namespaces,
    palette,
    authorColors,
    labelOf,
    resolveAuthorId,
    isEmpty: dataset.daily.size === 0,
  };
}

/** Nom lisible d'un auteur, avec repli sur l'identifiant. */
export function authorName(authors: ReadonlyMap<string, StoredAuthor>, id: string): string {
  return authors.get(id)?.displayName ?? id;
}

export function projectName(projects: ReadonlyMap<ProjectKey, StoredProject>, key: ProjectKey): string {
  return projects.get(key)?.pathWithNamespace ?? key;
}
