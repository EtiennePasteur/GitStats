/**
 * Étiquettes lisibles **et distinctes** pour un groupe de personnes.
 *
 * Deux identités non fusionnées portent très souvent le même nom affiché : la
 * même personne avec son adresse pro et son adresse perso, ou deux homonymes.
 * Une légende ECharts est indexée par le *nom* de série : deux séries homonymes
 * s'y replient sur une seule entrée, et l'une des deux courbes devient
 * impossible à nommer comme à masquer — on voit deux aires pour une seule
 * légende.
 *
 * On ne désambiguïse donc que les noms réellement en collision : dans le cas
 * courant, l'étiquette reste le nom seul.
 */

export interface LabelInput {
  id: string;
  name: string;
  /** Ce qui départage deux homonymes — l'e-mail principal, en pratique. */
  hint: string | null;
}

export function disambiguateLabels(entries: readonly LabelInput[]): Map<string, string> {
  const collisions = new Map<string, number>();
  for (const entry of entries) {
    collisions.set(entry.name, (collisions.get(entry.name) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const entry of entries) {
    const ambiguous = (collisions.get(entry.name) ?? 0) > 1;
    // Sans indice utilisable, mieux vaut le nom nu qu'une parenthèse vide : la
    // série reste ambiguë, mais l'étiquette n'est pas dégradée pour rien.
    labels.set(
      entry.id,
      ambiguous && entry.hint !== null && entry.hint !== '' ? `${entry.name} (${entry.hint})` : entry.name,
    );
  }
  return labels;
}
