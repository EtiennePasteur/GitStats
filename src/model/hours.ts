/**
 * Répartition horaire d'un seau journalier, en paires `[heure, commits]`.
 *
 * Forme creuse et non `number[24]` : le seau médian d'un parc réel porte moins
 * de deux commits, donc une seule heure distincte. Un tableau dense ferait
 * cloner vingt-quatre nombres à chaque écriture IndexedDB là où celui-ci en
 * clone deux — la même classe de surcoût que les index superflus déjà retirés
 * du magasin `daily`.
 *
 * Les paires sont TOUJOURS triées par heure croissante. La forme est ainsi
 * canonique : le fichier `.json` reste diffable, et deux répartitions égales le
 * sont au sens strict.
 *
 * Ce module n'importe rien, à dessein : il est consommé par `sync/` (interdit
 * de React) comme par `query/` et `store/`.
 */

/** Paires `[heure, commits]`, triées par heure croissante. */
export type PackedHours = number[];

/**
 * Ajoute des commits sur une heure. MUTE `packed` et le renvoie.
 *
 * Réservé à la boucle d'ingestion, seule propriétaire de ses tableaux. Partout
 * ailleurs les tableaux appartiennent au Dataset partagé : utiliser `mergeHours`.
 */
export function addHour(packed: PackedHours, hour: number, count = 1): PackedHours {
  for (let i = 0; i < packed.length; i += 2) {
    const at = packed[i] ?? 0;
    if (at === hour) {
      packed[i + 1] = (packed[i + 1] ?? 0) + count;
      return packed;
    }
    // Les paires étant triées, dépasser l'heure visée signifie qu'elle est absente.
    if (at > hour) {
      packed.splice(i, 0, hour, count);
      return packed;
    }
  }
  packed.push(hour, count);
  return packed;
}

/**
 * Additionne deux répartitions. Pure : ne mute jamais ses arguments.
 */
export function mergeHours(a: PackedHours, b: PackedHours): PackedHours {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];

  const result: PackedHours = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ha = a[i] ?? 0;
    const hb = b[j] ?? 0;
    if (ha === hb) {
      result.push(ha, (a[i + 1] ?? 0) + (b[j + 1] ?? 0));
      i += 2;
      j += 2;
    } else if (ha < hb) {
      result.push(ha, a[i + 1] ?? 0);
      i += 2;
    } else {
      result.push(hb, b[j + 1] ?? 0);
      j += 2;
    }
  }
  for (; i < a.length; i += 2) result.push(a[i] ?? 0, a[i + 1] ?? 0);
  for (; j < b.length; j += 2) result.push(b[j] ?? 0, b[j + 1] ?? 0);
  return result;
}

/**
 * Retire `b` de `a`, en saturant à zéro. Pure.
 *
 * Sert à écarter les heures des commits de merge quand le filtre correspondant
 * est actif : le total du rythme reste alors égal au nombre de commits affiché.
 */
export function subtractHours(a: PackedHours, b: PackedHours): PackedHours {
  if (a.length === 0 || b.length === 0) return [...a];

  const toRemove = new Map<number, number>();
  for (let j = 0; j < b.length; j += 2) toRemove.set(b[j] ?? 0, b[j + 1] ?? 0);

  const result: PackedHours = [];
  for (let i = 0; i < a.length; i += 2) {
    const hour = a[i] ?? 0;
    const left = (a[i + 1] ?? 0) - (toRemove.get(hour) ?? 0);
    if (left > 0) result.push(hour, left);
  }
  return result;
}

/** Copie défensive — les tableaux du Dataset ne doivent jamais fuiter en écriture. */
export function cloneHours(packed: PackedHours): PackedHours {
  return [...packed];
}

/** Nombre de commits portés par la répartition. */
export function sumHours(packed: PackedHours): number {
  let total = 0;
  for (let i = 1; i < packed.length; i += 2) total += packed[i] ?? 0;
  return total;
}

/**
 * Garde d'import : le fichier `.json` est fait pour être partagé, donc édité à
 * la main. Une répartition mal formée est ramenée à `[]` plutôt que de casser le
 * graphe — la ligne garde ses commits et ses lignes de code, seule sa barre
 * horaire manque.
 */
export function sanitizeHours(value: unknown): PackedHours {
  // Longueur impaire : la structure en paires est rompue, rien n'est récupérable.
  if (!Array.isArray(value) || value.length % 2 !== 0) return [];

  const byHour = new Map<number, number>();
  for (let i = 0; i < value.length; i += 2) {
    const hour: unknown = value[i];
    const count: unknown = value[i + 1];
    if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    byHour.set(hour, (byHour.get(hour) ?? 0) + Math.floor(count));
  }

  const result: PackedHours = [];
  for (const hour of [...byHour.keys()].sort((left, right) => left - right)) {
    result.push(hour, byHour.get(hour) ?? 0);
  }
  return result;
}
