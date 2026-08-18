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
    expect(rhythm.known).toBe(5);
    expect(rhythm.total).toBe(5);
  });

  it("déduit le jour de la semaine de la date du seau, sans dérive de fuseau", () => {
    const rhythm = rhythmFromBuckets([bucket({ day: '2026-08-17', commits: 4, hourly: [9, 4] })]);
    expect(rhythm.weekdays[1]).toBe(4); // lundi, index 0 = dimanche
    expect(rhythm.weekdays[0]).toBe(0);
  });

  it('compte un seau sans heures dans les jours mais pas dans les heures', () => {
    // Les seaux collectés avant l'introduction du champ : leur date reste exacte,
    // seule l'heure est perdue. Masquer le jour jetterait une information juste.
    const rhythm = rhythmFromBuckets([bucket({ commits: 5, hourly: undefined })]);
    expect(rhythm.weekdays[1]).toBe(5);
    expect(rhythm.hours.every((value) => value === 0)).toBe(true);
    expect(rhythm.known).toBe(0);
    expect(rhythm.total).toBe(5);
  });

  it('mesure la couverture en commits et non en seaux', () => {
    // Un seau ancien qui reçoit de nouveaux commits est partiellement couvert :
    // compter les seaux annoncerait 100 % là où la moitié des heures manque.
    const rhythm = rhythmFromBuckets([
      bucket({ commits: 7, hourly: [9, 3] }),
      bucket({ projectKey: 'inst-b~4', commits: 2, hourly: [14, 2] }),
    ]);
    expect(rhythm.known).toBe(5);
    expect(rhythm.total).toBe(9);
  });

  it('rend des compteurs nuls sur un périmètre vide', () => {
    const rhythm = rhythmFromBuckets([]);
    expect(rhythm.hours).toHaveLength(24);
    expect(rhythm.weekdays).toHaveLength(7);
    expect(rhythm.known).toBe(0);
    expect(rhythm.total).toBe(0);
  });

  it("n'altère pas les seaux qu'il lit", () => {
    const input = bucket({ commits: 2, hourly: [9, 2] });
    rhythmFromBuckets([input]);
    expect(input.hourly).toEqual([9, 2]);
    expect(input.commits).toBe(2);
  });
});
