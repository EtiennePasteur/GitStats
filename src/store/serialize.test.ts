import { describe, it, expect } from 'vitest';
import { serializeDataset, deserializeDataset, InvalidFileError, FILE_VERSION } from './serialize';
import { emptyDataset } from './dataset';
import type { Dataset } from './dataset';
import type { DailyBucket } from '../model/types';

const AMELIE = 'a.riviere@example.com';

function datasetWith(buckets: DailyBucket[]): Dataset {
  const dataset = emptyDataset();
  dataset.authors.set(AMELIE, {
    id: AMELIE,
    displayName: 'Amélie Rivière',
    primaryEmail: AMELIE,
    identityKeys: [AMELIE],
    knownNames: ['Amélie Rivière'],
    knownEmails: [AMELIE],
    isBot: false,
  });
  for (const bucket of buckets) dataset.daily.set(bucket.key, bucket);
  return dataset;
}

function bucket(over: Partial<DailyBucket> = {}): DailyBucket {
  const day = over.day ?? '2026-08-17';
  const projectKey = over.projectKey ?? 'inst-a~1';
  return {
    key: `${projectKey}|${AMELIE}|${day}`,
    projectKey,
    authorId: AMELIE,
    day,
    commits: 3,
    additions: 30,
    deletions: 10,
    merges: 0,
    hourly: [9, 3],
    hourlyMerges: [],
    ...over,
  };
}

/** Aller-retour complet, en passant par JSON comme le fait un vrai export. */
function roundTrip(dataset: Dataset): Dataset {
  return deserializeDataset(JSON.parse(JSON.stringify(serializeDataset(dataset))));
}

describe('fichier .json', () => {
  it('fait survivre la répartition horaire à un aller-retour', () => {
    const source = datasetWith([bucket({ commits: 3, hourly: [9, 2, 14, 1] })]);
    const back = [...roundTrip(source).daily.values()][0]!;
    expect(back.hourly).toEqual([9, 2, 14, 1]);
  });

  it('écrit toujours les deux répartitions, merges compris', () => {
    const withMerge = serializeDataset(
      datasetWith([bucket({ merges: 1, hourly: [9, 3], hourlyMerges: [9, 1] })]),
    );
    expect(withMerge.daily[0]).toHaveLength(9);
    expect(withMerge.daily[0]![8]).toEqual([9, 1]);

    const without = serializeDataset(datasetWith([bucket({ hourly: [9, 3] })]));
    expect(without.daily[0]).toHaveLength(9);
    expect(without.daily[0]![8]).toEqual([]);
  });

  it('ignore une répartition aberrante dans un fichier trafiqué', () => {
    const file = serializeDataset(datasetWith([bucket({ hourly: [9, 3] })]));
    const tampered = { ...file, daily: file.daily.map((row) => [...row.slice(0, 7), [42, 3], []]) };
    const back = [...deserializeDataset(JSON.parse(JSON.stringify(tampered))).daily.values()][0]!;
    // La ligne garde ses commits : seule sa barre horaire manque.
    expect(back.hourly).toEqual([]);
    expect(back.commits).toBe(3);
  });

  it("refuse un fichier produit par une autre version de l'application", () => {
    const file = serializeDataset(datasetWith([bucket({ hourly: [9, 3] })]));
    expect(file.version).toBe(FILE_VERSION);
    const foreign = { ...file, version: FILE_VERSION + 1 };
    expect(() => deserializeDataset(foreign)).toThrow(InvalidFileError);
  });
});
