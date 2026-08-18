import { describe, it, expect } from 'vitest';
import { serializeDataset, deserializeDataset } from './serialize';
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

  it('laisse sans heures un seau qui n\'en portait pas', () => {
    // La distinction « inconnu » / « connu et vide » est le seul marqueur de
    // couverture : l'écraser ferait mentir la carte après un export/import.
    const source = datasetWith([bucket({ hourly: undefined })]);
    const file = serializeDataset(source);
    expect(file.daily[0]).toHaveLength(7);
    expect([...roundTrip(source).daily.values()][0]!.hourly).toBeUndefined();
  });

  it('n\'écrit les heures de merge que si le seau en porte', () => {
    const withMerge = serializeDataset(
      datasetWith([bucket({ merges: 1, hourly: [9, 3], hourlyMerges: [9, 1] })]),
    );
    expect(withMerge.daily[0]).toHaveLength(9);

    const without = serializeDataset(datasetWith([bucket({ hourly: [9, 3] })]));
    expect(without.daily[0]).toHaveLength(8);
  });

  it('lit une ligne à 7 éléments produite par une version antérieure', () => {
    const file = serializeDataset(datasetWith([bucket({ hourly: [9, 3] })]));
    // On rabote la ligne comme le ferait un fichier exporté avant le changement.
    const legacy = { ...file, daily: file.daily.map((row) => row.slice(0, 7)) };
    const back = [...deserializeDataset(JSON.parse(JSON.stringify(legacy))).daily.values()][0]!;
    expect(back.commits).toBe(3);
    expect(back.hourly).toBeUndefined();
  });

  it('ignore une répartition aberrante dans un fichier trafiqué', () => {
    const file = serializeDataset(datasetWith([bucket({ hourly: [9, 3] })]));
    const tampered = { ...file, daily: file.daily.map((row) => [...row.slice(0, 7), [42, 3]]) };
    const back = [...deserializeDataset(JSON.parse(JSON.stringify(tampered))).daily.values()][0]!;
    expect(back.hourly).toBeUndefined();
    expect(back.commits).toBe(3);
  });

  it('reste ouvrable par une version antérieure, qui y cherche les rythmes', () => {
    const file = serializeDataset(datasetWith([bucket({ hourly: [9, 3] })]));
    expect(file.rhythms).toEqual([]);
    expect(file.version).toBe(2);
  });
});
