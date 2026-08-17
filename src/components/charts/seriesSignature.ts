/**
 * Signature d'identité des séries d'une option ECharts.
 *
 * `setOption` fusionnant apparie les séries par `id`, puis par `name`, puis par
 * position — et **conserve celles qu'il n'apparie pas**. Retirer une série de
 * l'option ne l'enlève donc pas du graphique, et une nouvelle série reprend le
 * créneau libéré par une disparue, dont elle hérite le rang d'empilement. Sur un
 * comparateur où l'utilisateur change les séries à chaque clic, cela affiche des
 * personnes qu'il vient de retirer.
 *
 * Comparer cette signature d'un rendu à l'autre dit s'il faut reconstruire
 * l'option (`notMerge`) plutôt que la fusionner. L'ordre compte : à jeu de
 * séries identique mais réordonné, seule une reconstruction rend le nouvel
 * ordre d'empilement.
 */

interface SeriesLike {
  id?: unknown;
  name?: unknown;
  type?: unknown;
}

/** Séparateur impossible dans un identifiant ou un nom de série. */
const UNIT = '\u0000';

export function seriesSignature(option: { series?: unknown }): string {
  const { series } = option;
  const list: unknown[] = Array.isArray(series) ? series : series == null ? [] : [series];

  return list
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return '?';
      const item = entry as SeriesLike;
      // `id` d'abord : c'est la seule clé qu'ECharts respecte sans ambiguïté.
      // À défaut, le nom — deux séries homonymes se confondent alors, ce que la
      // désambiguïsation des étiquettes évite en amont.
      const identity = item.id ?? item.name ?? '';
      return `${String(item.type ?? '')}:${String(identity)}`;
    })
    .join(UNIT);
}
