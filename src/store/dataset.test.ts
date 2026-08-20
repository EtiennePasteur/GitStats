import { describe, it, expect } from 'vitest';
import {
  emptyDataset,
  mergeBucketsInMemory,
  reconcileAuthors,
  recoverManualAliases,
  alignAuthorsToAliases,
  type Dataset,
} from './dataset';
import { sumHours } from '../model/hours';
import { DEFAULT_SYNC_CONFIG, type DailyBucket, type StoredAuthor, type StoredMeta } from '../model/types';

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

describe('reconcileAuthors — fiches d\'auteurs manquantes', () => {
  it('recrée une fiche pour chaque personne citée par un seau', () => {
    const dataset = emptyDataset();
    mergeBucketsInMemory(dataset, [
      bucket(),
      bucket({ projectKey: 'inst-a~2', authorId: 'k.benali@example.org', key: 'inst-a~2|k|d' }),
    ]);
    expect(dataset.authors.size).toBe(0);

    expect(reconcileAuthors(dataset)).toBe(2);
    expect([...dataset.authors.keys()].sort()).toEqual([AMELIE, 'k.benali@example.org']);
    // À défaut de nom observé, la partie locale de l'adresse — jamais l'adresse nue.
    expect(dataset.authors.get(AMELIE)!.displayName).toBe('a.riviere');
  });

  it('marque les robots, sans quoi « Exclure les robots » ne filtrerait plus rien', () => {
    const dataset = emptyDataset();
    mergeBucketsInMemory(dataset, [bucket({ authorId: 'dependabot@example.com', key: 'inst-a~1|d|d' })]);

    reconcileAuthors(dataset);
    expect(dataset.authors.get('dependabot@example.com')!.isBot).toBe(true);
  });

  it('ne touche pas aux fiches déjà présentes', () => {
    const dataset = emptyDataset();
    const existing: StoredAuthor = {
      id: AMELIE,
      displayName: 'Amélie Rivière',
      primaryEmail: AMELIE,
      identityKeys: [AMELIE],
      knownNames: ['Amélie Rivière'],
      knownEmails: [AMELIE],
      isBot: false,
    };
    dataset.authors.set(AMELIE, existing);
    mergeBucketsInMemory(dataset, [bucket()]);

    expect(reconcileAuthors(dataset)).toBe(0);
    expect(dataset.authors.get(AMELIE)).toBe(existing);
  });

  it('couvre aussi les personnes connues des seuls aperçus', () => {
    const dataset = emptyDataset();
    dataset.overviews.set('inst-a~1', {
      projectKey: 'inst-a~1',
      fetchedAt: '2026-08-19T00:00:00.000Z',
      entries: [{ authorId: 'k.benali@example.org', commits: 40, additions: 100, deletions: 20 }],
    });

    expect(reconcileAuthors(dataset)).toBe(1);
    expect(dataset.authors.has('k.benali@example.org')).toBe(true);
  });
});

describe('recoverManualAliases — fusions figées dans les fiches', () => {
  function meta(manualAliases: Record<string, string> = {}): StoredMeta {
    return { instances: [], window: null, lastSyncAt: null, config: DEFAULT_SYNC_CONFIG, manualAliases };
  }

  const MERGED: StoredAuthor = {
    id: AMELIE,
    displayName: 'Amélie Rivière',
    primaryEmail: AMELIE,
    identityKeys: [AMELIE, 'amelie.riviere@example.net'],
    knownNames: ['Amélie Rivière'],
    knownEmails: [AMELIE],
    isBot: false,
  };

  it('reconstitue l\'alias d\'une fiche à deux identités', () => {
    const dataset = emptyDataset();
    dataset.meta = meta();
    dataset.authors.set(MERGED.id, MERGED);

    expect(recoverManualAliases(dataset)).toBe(1);
    // La fusion redevient visible dans les réglages, donc annulable.
    expect(dataset.meta.manualAliases).toEqual({ 'amelie.riviere@example.net': AMELIE });
  });

  it('ne touche pas à une personne mono-adresse', () => {
    const dataset = emptyDataset();
    dataset.meta = meta();
    dataset.authors.set(AMELIE, { ...MERGED, identityKeys: [AMELIE] });

    expect(recoverManualAliases(dataset)).toBe(0);
    expect(dataset.meta.manualAliases).toEqual({});
  });

  it('laisse la main à un alias déjà présent, même s\'il désigne une autre cible', () => {
    const dataset = emptyDataset();
    const other = 'k.benali@example.org';
    dataset.meta = meta({ 'amelie.riviere@example.net': other });
    dataset.authors.set(MERGED.id, MERGED);

    expect(recoverManualAliases(dataset)).toBe(0);
    expect(dataset.meta.manualAliases).toEqual({ 'amelie.riviere@example.net': other });
  });

  it('est idempotent', () => {
    const dataset = emptyDataset();
    dataset.meta = meta();
    dataset.authors.set(MERGED.id, MERGED);

    expect(recoverManualAliases(dataset)).toBe(1);
    expect(recoverManualAliases(dataset)).toBe(0);
  });
});

describe('alignAuthorsToAliases — annulation d\'une fusion', () => {
  const OTHER = 'amelie.riviere@example.net';

  function merged(): Dataset {
    const dataset = emptyDataset();
    dataset.meta = {
      instances: [], window: null, lastSyncAt: null,
      config: DEFAULT_SYNC_CONFIG,
      manualAliases: { [OTHER]: AMELIE },
    };
    dataset.authors.set(AMELIE, {
      id: AMELIE,
      displayName: 'Amélie Rivière',
      primaryEmail: AMELIE,
      identityKeys: [AMELIE, OTHER],
      knownNames: ['Amélie Rivière'],
      knownEmails: [AMELIE],
      isBot: false,
      manual: true,
    });
    // Les deux identités gardent leurs propres seaux : ils ne sont jamais réécrits.
    mergeBucketsInMemory(dataset, [
      bucket(),
      bucket({ authorId: OTHER, key: `inst-a~1|${OTHER}|2026-08-17` }),
    ]);
    return dataset;
  }

  it('ne détache rien tant que l\'alias est là', () => {
    const dataset = merged();
    expect(alignAuthorsToAliases(dataset)).toEqual([]);
    expect(dataset.authors.get(AMELIE)!.identityKeys).toEqual([AMELIE, OTHER]);
  });

  it('détache l\'identité et lui rend une fiche quand l\'alias tombe', () => {
    const dataset = merged();
    dataset.meta!.manualAliases = {};

    expect(alignAuthorsToAliases(dataset)).toEqual([OTHER]);
    expect(dataset.authors.get(AMELIE)!.identityKeys).toEqual([AMELIE]);
    // Plus de fusion manuelle sur cette fiche…
    expect(dataset.authors.get(AMELIE)!.manual).toBeUndefined();
    // …et l'identité détachée redevient une personne à part entière.
    expect(dataset.authors.get(OTHER)?.displayName).toBe('amelie.riviere');
  });

  it('ferme la boucle : après annulation, l\'alias n\'est plus rétabli', () => {
    const dataset = merged();
    dataset.meta!.manualAliases = {};
    alignAuthorsToAliases(dataset);

    // Sans le réalignement, `recoverManualAliases` déduirait de la fiche encore
    // fusionnée qu'il faut rétablir l'alias — et annulerait l'annulation.
    expect(recoverManualAliases(dataset)).toBe(0);
    expect(dataset.meta!.manualAliases).toEqual({});
  });
});
