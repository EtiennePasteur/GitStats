import { describe, it, expect } from 'vitest';
import {
  pickGranularity,
  bucketOfDay,
  aggregateByGranularity,
  byDayAndAuthor,
  partialEdges,
  fillDays,
  type DayPoint,
} from './selectors';
import type { DailyBucket } from '../model/types';

describe('pickGranularity', () => {
  it('reste au jour sur les périodes courtes et regroupe au-delà', () => {
    expect(pickGranularity(7)).toBe('day');
    expect(pickGranularity(92)).toBe('day');
    // 365 points journaliers sur un graphique large donnent un peigne illisible.
    expect(pickGranularity(93)).toBe('week');
    expect(pickGranularity(365)).toBe('week');
    expect(pickGranularity(551)).toBe('month');
  });
});

describe('bucketOfDay', () => {
  it('ramène au lundi de la semaine', () => {
    expect(bucketOfDay('2026-08-17', 'week')).toBe('2026-08-17'); // lundi
    expect(bucketOfDay('2026-08-19', 'week')).toBe('2026-08-17'); // mercredi
    expect(bucketOfDay('2026-08-23', 'week')).toBe('2026-08-17'); // dimanche
    expect(bucketOfDay('2026-08-24', 'week')).toBe('2026-08-24'); // lundi suivant
  });

  it('ramène au premier du mois', () => {
    expect(bucketOfDay('2026-08-17', 'month')).toBe('2026-08-01');
    expect(bucketOfDay('2026-01-31', 'month')).toBe('2026-01-01');
  });

  it('laisse le jour intact au pas journalier', () => {
    expect(bucketOfDay('2026-08-17', 'day')).toBe('2026-08-17');
  });
});

describe('aggregateByGranularity', () => {
  const points: DayPoint[] = [
    { day: '2026-08-17', commits: 3, additions: 30, deletions: 10 },
    { day: '2026-08-18', commits: 2, additions: 20, deletions: 5 },
    { day: '2026-08-24', commits: 5, additions: 50, deletions: 15 },
  ];

  it('additionne sans rien perdre', () => {
    const weekly = aggregateByGranularity(points, 'week');
    expect(weekly).toEqual([
      { day: '2026-08-17', commits: 5, additions: 50, deletions: 15 },
      { day: '2026-08-24', commits: 5, additions: 50, deletions: 15 },
    ]);
    const before = points.reduce((sum, p) => sum + p.commits, 0);
    expect(weekly.reduce((sum, p) => sum + p.commits, 0)).toBe(before);
  });

  it('ne touche à rien au pas journalier', () => {
    expect(aggregateByGranularity(points, 'day')).toBe(points);
  });
});

describe('byDayAndAuthor — agrégation temporelle', () => {
  const PROJECT = 'inst-a~1';
  function bucket(day: string, authorId: string, commits: number): DailyBucket {
    return {
      key: `${PROJECT}|${authorId}|${day}`,
      projectKey: PROJECT,
      authorId,
      day,
      commits,
      additions: 0,
      deletions: 0,
      merges: 0,
    };
  }

  it('regroupe par semaine sans perdre de commits', () => {
    const buckets = [
      bucket('2026-08-17', 'a', 1),
      bucket('2026-08-18', 'a', 2),
      bucket('2026-08-19', 'a', 3),
      bucket('2026-08-24', 'a', 4),
    ];
    const result = byDayAndAuthor(buckets, ['a'], { granularity: 'week' });
    expect(result.days).toEqual(['2026-08-17', '2026-08-24']);
    expect(result.series[0]!.values).toEqual([6, 4]);
    expect(result.granularity).toBe('week');
  });

  it('choisit le pas tout seul selon l\'étalement', () => {
    const buckets = [bucket('2025-08-17', 'a', 1), bucket('2026-08-17', 'a', 1)];
    expect(byDayAndAuthor(buckets, ['a']).granularity).toBe('week');

    const short = [bucket('2026-08-01', 'a', 1), bucket('2026-08-17', 'a', 1)];
    expect(byDayAndAuthor(short, ['a']).granularity).toBe('day');
  });

  it('conserve le total quand la période tombe juste sur les bornes de seaux', () => {
    // Du lundi 2025-08-04 au dimanche 2026-08-02 : 52 semaines pleines, aucun
    // bord partiel à retirer.
    const buckets = Array.from({ length: 364 }, (_, i) => {
      const date = new Date('2025-08-04T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + i);
      return bucket(date.toISOString().slice(0, 10), 'a', 2);
    });
    for (const granularity of ['day', 'week'] as const) {
      const result = byDayAndAuthor(buckets, ['a'], { granularity });
      const total = result.series[0]!.values.reduce((sum, v) => sum + v, 0);
      expect(total).toBe(728);
    }
  });

  it('écarte les seaux de bord incomplets', () => {
    // Du mercredi 5 août au mercredi 26 août : les semaines des DEUX extrémités
    // sont tronquées et dessineraient une fausse chute d'activité. Restent les
    // semaines pleines du 10 et du 17.
    const buckets = [
      bucket('2026-08-05', 'a', 100), // semaine du 3, partielle
      bucket('2026-08-10', 'a', 10),
      bucket('2026-08-14', 'a', 10), // semaine du 10, pleine
      bucket('2026-08-17', 'a', 7), // semaine du 17, pleine
      bucket('2026-08-26', 'a', 100), // semaine du 24, partielle
    ];
    const result = byDayAndAuthor(buckets, ['a'], { granularity: 'week' });
    expect(result.days).toEqual(['2026-08-10', '2026-08-17']);
    expect(result.series[0]!.values).toEqual([20, 7]);
  });

  it('ne retire jamais de bord quand il y a trop peu de seaux', () => {
    // Sur deux seaux, retirer les bords ne laisserait rien à afficher.
    const buckets = [bucket('2026-08-05', 'a', 5), bucket('2026-08-12', 'a', 5)];
    const result = byDayAndAuthor(buckets, ['a'], { granularity: 'week' });
    expect(result.series[0]!.values.reduce((sum, v) => sum + v, 0)).toBe(10);
  });
});

describe('partialEdges / trimPartialEdges', () => {
  /** Série dense, comme celle que produit `byDay` en usage réel. */
  const dense = (from: string, to: string, perDay: number): DayPoint[] =>
    fillDays(from, to).map((day) => ({ day, commits: perDay, additions: 0, deletions: 0 }));

  it('repère les bords partiels', () => {
    // Mercredi → mercredi : deux bords tronqués.
    expect(partialEdges(fillDays('2026-08-05', '2026-08-26'), 'week')).toEqual({
      first: true,
      last: true,
    });
    // Lundi → dimanche : aucun bord tronqué.
    expect(partialEdges(fillDays('2026-08-03', '2026-08-23'), 'week')).toEqual({
      first: false,
      last: false,
    });
    // Au pas journalier, la notion n'a pas de sens.
    expect(partialEdges(fillDays('2026-08-05', '2026-08-26'), 'day')).toEqual({
      first: false,
      last: false,
    });
  });

  it("laisse les totaux intacts : seul l'affichage est rogné", () => {
    const points = dense('2026-08-05', '2026-08-26', 10); // 22 jours × 10
    const kept = aggregateByGranularity(points, 'week');
    const trimmed = aggregateByGranularity(points, 'week', { trimPartialEdges: true });

    // Sans l'option, rien n'est perdu — c'est ce que consomment KPI et tableaux.
    expect(kept.reduce((sum, p) => sum + p.commits, 0)).toBe(220);
    // Avec l'option, seules les semaines pleines restent : 2 × 7 jours × 10.
    expect(trimmed.map((p) => p.day)).toEqual(['2026-08-10', '2026-08-17']);
    expect(trimmed.reduce((sum, p) => sum + p.commits, 0)).toBe(140);
  });

  it('ne rogne rien quand la période tombe pile sur les bornes', () => {
    const points = dense('2026-08-03', '2026-08-23', 10); // lundi → dimanche
    const trimmed = aggregateByGranularity(points, 'week', { trimPartialEdges: true });
    expect(trimmed).toHaveLength(3);
    expect(trimmed.reduce((sum, p) => sum + p.commits, 0)).toBe(210);
  });
});
