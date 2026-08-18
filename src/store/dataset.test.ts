import { describe, it, expect } from 'vitest';
import { emptyDataset, mergeBucketsInMemory } from './dataset';
import { sumHours } from '../model/hours';
import type { DailyBucket } from '../model/types';

const AMELIE = 'a.riviere@example.com';

function bucket(over: Partial<DailyBucket> = {}): DailyBucket {
  const day = over.day ?? '2026-08-17';
  const projectKey = over.projectKey ?? 'inst-a~1';
  return {
    key: `${projectKey}|${AMELIE}|${day}`,
    projectKey,
    authorId: AMELIE,
    day,
    commits: 1,
    additions: 10,
    deletions: 3,
    merges: 0,
    hourly: [9, 1],
    hourlyMerges: [],
    ...over,
  };
}

describe('fusion des seaux en mémoire', () => {
  it('additionne les heures comme les commits', () => {
    const dataset = emptyDataset();
    mergeBucketsInMemory(dataset, [bucket({ commits: 2, hourly: [9, 2] })]);
    mergeBucketsInMemory(dataset, [bucket({ commits: 3, hourly: [9, 1, 14, 2] })]);
    const merged = [...dataset.daily.values()][0]!;
    expect(merged.commits).toBe(5);
    expect(merged.hourly).toEqual([9, 3, 14, 2]);
  });

  it('ne partage jamais ses tableaux avec le résultat d\'ingestion', () => {
    // `{ ...bucket }` est une copie superficielle : sans clone explicite, muter
    // le Dataset réécrirait le lot fraîchement ingéré, et inversement.
    const dataset = emptyDataset();
    const incoming = bucket({ commits: 2, hourly: [9, 2] });
    mergeBucketsInMemory(dataset, [incoming]);
    expect([...dataset.daily.values()][0]!.hourly).not.toBe(incoming.hourly);
  });

  it('garde les heures et les commits d\'accord quand un jour se recouvre', () => {
    // La fenêtre de recouvrement ramène des commits sur un jour déjà collecté :
    // les deux compteurs doivent progresser ensemble, sinon le total du rythme
    // divergerait du KPI « Commits ».
    const dataset = emptyDataset();
    mergeBucketsInMemory(dataset, [bucket({ commits: 4, hourly: [9, 4] })]);
    mergeBucketsInMemory(dataset, [bucket({ commits: 1, hourly: [14, 1] })]);
    const merged = [...dataset.daily.values()][0]!;
    expect(merged.commits).toBe(5);
    expect(sumHours(merged.hourly)).toBe(5);
  });
});
