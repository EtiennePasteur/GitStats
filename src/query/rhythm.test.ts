import { describe, it, expect } from 'vitest';
import { rhythmFromBuckets } from './rhythm';
import type { DailyBucket } from '../model/types';

const AMELIE = 'a.riviere@example.com';

function bucket(overrides: Partial<DailyBucket> = {}): DailyBucket {
  const day = overrides.day ?? '2026-08-17'; // un lundi
  const projectKey = overrides.projectKey ?? 'inst-a~1';
  const authorId = overrides.authorId ?? AMELIE;
  return {
    key: `${projectKey}|${authorId}|${day}`,
    projectKey,
    authorId,
    day,
    commits: 1,
    additions: 10,
    deletions: 3,
    merges: 0,
    hourly: [9, 1],
    hourlyMerges: [],
    ...overrides,
  };
}

describe('rythme de travail', () => {
  it('agrège les heures de plusieurs seaux', () => {
    const rhythm = rhythmFromBuckets([
      bucket({ commits: 3, hourly: [9, 2, 14, 1] }),
      bucket({ projectKey: 'inst-b~4', commits: 2, hourly: [9, 1, 22, 1] }),
    ]);
    expect(rhythm.hours[9]).toBe(3);
    expect(rhythm.hours[14]).toBe(1);
    expect(rhythm.hours[22]).toBe(1);
  });

  it("déduit le jour de la semaine de la date du seau, sans dérive de fuseau", () => {
    const rhythm = rhythmFromBuckets([bucket({ day: '2026-08-17', commits: 4, hourly: [9, 4] })]);
    expect(rhythm.weekdays[1]).toBe(4); // lundi, index 0 = dimanche
    expect(rhythm.weekdays[0]).toBe(0);
  });

  it('rend des compteurs nuls sur un périmètre vide', () => {
    const rhythm = rhythmFromBuckets([]);
    expect(rhythm.hours).toHaveLength(24);
    expect(rhythm.weekdays).toHaveLength(7);
    expect(rhythm.hours.every((value) => value === 0)).toBe(true);
    expect(rhythm.weekdays.every((value) => value === 0)).toBe(true);
  });

  it('compte les mêmes commits dans les heures et dans les jours', () => {
    // C'est ce qui garantit que le total du graphe égale le KPI « Commits »
    // affiché juste au-dessus, quel que soit le filtre appliqué en amont.
    const rhythm = rhythmFromBuckets([
      bucket({ commits: 7, hourly: [9, 4, 14, 3] }),
      bucket({ projectKey: 'inst-b~4', commits: 2, hourly: [22, 2] }),
    ]);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    expect(sum(rhythm.hours)).toBe(9);
    expect(sum(rhythm.weekdays)).toBe(9);
  });

  it("n'altère pas les seaux qu'il lit", () => {
    const input = bucket({ commits: 2, hourly: [9, 2] });
    rhythmFromBuckets([input]);
    expect(input.hourly).toEqual([9, 2]);
    expect(input.commits).toBe(2);
  });
});
