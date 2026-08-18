/**
 * Rythme de travail, recalculé À LA LECTURE depuis les seaux déjà filtrés.
 *
 * L'ancienne version lisait un magasin pré-agrégé à l'ingestion, sans date ni
 * dépôt : elle ignorait toute la barre de filtres, comptait deux fois les dépôts
 * mirrorés et se trompait de personne dès qu'une identité était fusionnée.
 * Partir des seaux rend tout cela correct sans une ligne de filtrage ici.
 *
 * `weekdays` ne se stocke pas : il se déduit de `bucket.day`. Les deux moitiés
 * comptent donc exactement les mêmes commits, et leur total vaut celui du KPI
 * « Commits » de la même page.
 */

import type { DailyBucket } from '../model/types';
import { localWeekday } from '../sync/aggregate';

export interface Rhythm {
  /** 24 compteurs, index = heure locale de l'auteur du commit. */
  hours: number[];
  /** 7 compteurs, index 0 = dimanche (convention `Date.getUTCDay`). */
  weekdays: number[];
}

export function rhythmFromBuckets(buckets: readonly DailyBucket[]): Rhythm {
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);

  for (const bucket of buckets) {
    const weekday = localWeekday(bucket.day);
    weekdays[weekday] = (weekdays[weekday] ?? 0) + bucket.commits;

    const packed = bucket.hourly;
    for (let i = 0; i < packed.length; i += 2) {
      const hour = packed[i] ?? 0;
      if (hour < 0 || hour > 23) continue;
      hours[hour] = (hours[hour] ?? 0) + (packed[i + 1] ?? 0);
    }
  }

  return { hours, weekdays };
}
