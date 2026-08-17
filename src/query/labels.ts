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

/** `a.riviere@example.com` → `a.riviere`. Sans arobase, l'indice entier. */
function localPart(hint: string): string {
  const at = hint.indexOf('@');
  return at > 0 ? hint.slice(0, at) : hint;
}

export function disambiguateLabels(entries: readonly LabelInput[]): Map<string, string> {
  const groups = new Map<string, LabelInput[]>();
  for (const entry of entries) {
    const group = groups.get(entry.name);
    if (group === undefined) groups.set(entry.name, [entry]);
    else group.push(entry);
  }

  const labels = new Map<string, string>();
  for (const [name, group] of groups) {
    const usable = group.filter((entry) => entry.hint !== null && entry.hint !== '');
    // Le login suffit presque toujours à départager, et tient dans une légende
    // ou une barre de classement là où l'adresse complète se ferait tronquer.
    // On ne déplie l'adresse que si deux homonymes partagent aussi leur login,
    // sur deux domaines différents — le cas existe.
    const locals = usable.map((entry) => localPart(entry.hint!));
    const shortEnough = new Set(locals).size === locals.length;

    for (const entry of group) {
      // Sans indice utilisable, mieux vaut le nom nu qu'une parenthèse vide : la
      // série reste ambiguë, mais l'étiquette n'est pas dégradée pour rien.
      const hint = entry.hint !== null && entry.hint !== '' ? entry.hint : null;
      labels.set(
        entry.id,
        group.length > 1 && hint !== null ? `${name} (${shortEnough ? localPart(hint) : hint})` : name,
      );
    }
  }
  return labels;
}
