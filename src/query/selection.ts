/**
 * Sélection multiple bornée, avec une sélection par défaut.
 *
 * Le piège que ce module existe pour éviter : quand l'écran affiche une
 * sélection par défaut (« les 3 premiers contributeurs ») sans l'avoir inscrite
 * dans l'état, le premier clic de l'utilisateur porte sur un état vide. Cliquer
 * sur une puce qui paraît active est alors interprété comme un AJOUT, et non
 * comme le retrait attendu — la personne qu'on voulait enlever reste seule à
 * l'écran pendant que les autres disparaissent.
 *
 * D'où la distinction explicite :
 *   `null` = l'utilisateur n'a pas encore choisi, on affiche le défaut ;
 *   `[]`   = l'utilisateur a tout retiré, et c'est un choix légitime.
 */

/** Sélection affichée : le choix de l'utilisateur, ou le défaut s'il n'a rien touché. */
export function effectiveSelection(
  current: readonly string[] | null,
  fallback: readonly string[],
): readonly string[] {
  return current ?? fallback;
}

/**
 * Sélection réellement exploitable : le choix affiché, amputé de ce qui est
 * sorti du périmètre.
 *
 * Une personne choisie puis masquée par un filtre (dépôt, période) n'a plus de
 * puce à l'écran. La laisser dans la sélection lui ferait occuper une place sur
 * le maximum autorisé — quota atteint alors que l'utilisateur ne voit que deux
 * sélections — sans lui donner le moyen de la retirer. Le choix brut, lui,
 * n'est pas réécrit : il revient si le filtre se rouvre.
 */
export function visibleSelection(
  current: readonly string[] | null,
  fallback: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  return effectiveSelection(current, fallback).filter((id) => known.has(id));
}

/**
 * Bascule un identifiant. Le premier clic matérialise le défaut, de sorte que
 * l'action porte toujours sur ce qui est réellement affiché.
 *
 * @param max Nombre maximum d'éléments. Un ajout au-delà est ignoré ; un retrait
 *   reste toujours possible, même si la sélection dépasse déjà la limite.
 */
export function toggleSelection(
  current: readonly string[] | null,
  fallback: readonly string[],
  id: string,
  max: number,
): string[] {
  const base = [...effectiveSelection(current, fallback)];
  const index = base.indexOf(id);
  if (index >= 0) {
    base.splice(index, 1);
    return base;
  }
  if (base.length >= max) return base;
  base.push(id);
  return base;
}

/** `true` si ajouter cet identifiant serait refusé faute de place. */
export function isSelectionFull(
  current: readonly string[] | null,
  fallback: readonly string[],
  id: string,
  max: number,
): boolean {
  const base = effectiveSelection(current, fallback);
  return base.length >= max && !base.includes(id);
}
