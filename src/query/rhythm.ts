/**
 * Rythme de travail, recalculé À LA LECTURE depuis les seaux déjà filtrés.
 *
 * L'ancienne version lisait un magasin pré-agrégé à l'ingestion, sans date ni
 * dépôt : elle ignorait toute la barre de filtres, comptait deux fois les dépôts
 * mirrorés et se trompait de personne dès qu'une identité était fusionnée.
 * Partir des seaux rend tout cela correct sans une ligne de filtrage ici.
 *
 * Asymétrie assumée entre les deux moitiés du résultat :
 *  - `weekdays` se déduit de `bucket.day`, donc il est exact sur 100 % du
 *    périmètre, y compris les seaux collectés avant que les heures existent ;
 *  - `hours` ne peut compter que les seaux qui en portent.
 * D'où `known` / `total`, qui laissent l'appelant dire la couverture plutôt que
 * de la passer sous silence. Elle se mesure en COMMITS et non en seaux : un seau
 * ancien peut recevoir de nouveaux commits par la fenêtre de recouvrement et se
 * retrouver partiellement couvert.
 */

import type { DailyBucket } from '../model/types';
import { sumHours } from '../model/hours';
import { localWeekday } from '../sync/aggregate';

export interface Rhythm {
  /** 24 compteurs, index = heure locale de l'auteur du commit. */
  hours: number[];
  /** 7 compteurs, index 0 = dimanche (convention `Date.getUTCDay`). */
  weekdays: number[];
  /** Commits dont l'heure est connue — égal à la somme de `hours`. */
  known: number;
  /** Commits du périmètre, heure connue ou non. */
  total: number;
}

export function rhythmFromBuckets(buckets: readonly DailyBucket[]): Rhythm {
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  let known = 0;
  let total = 0;

  for (const bucket of buckets) {
    total += bucket.commits;

    const weekday = localWeekday(bucket.day);
    weekdays[weekday] = (weekdays[weekday] ?? 0) + bucket.commits;

    const packed = bucket.hourly;
    if (packed === undefined) continue;
    for (let i = 0; i < packed.length; i += 2) {
      const hour = packed[i] ?? 0;
      if (hour < 0 || hour > 23) continue;
      hours[hour] = (hours[hour] ?? 0) + (packed[i + 1] ?? 0);
    }
    known += sumHours(packed);
  }

  return { hours, weekdays, known, total };
}
