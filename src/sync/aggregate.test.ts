import { describe, it, expect } from 'vitest';
import { ingestCommits, localDay, localHour, localWeekday, trimRecentShas } from './aggregate';
import { IdentityResolver } from './identity';
import { OVERLAP_DAYS } from '../model/types';
import type { GitLabCommit } from '../gitlab/types';

function commit(overrides: Partial<GitLabCommit> = {}): GitLabCommit {
  return {
    id: 'a'.repeat(40),
    short_id: 'aaaaaaa',
    title: 'feat: quelque chose',
    author_name: 'Amélie Rivière',
    author_email: 'a.riviere@example.com',
    authored_date: '2026-08-17T10:30:00.000+02:00',
    committer_name: 'Amélie Rivière',
    committer_email: 'a.riviere@example.com',
    committed_date: '2026-08-17T10:30:00.000+02:00',
    parent_ids: ['b'.repeat(40)],
    web_url: 'https://git/commit/a',
    stats: { additions: 10, deletions: 3, total: 13 },
    ...overrides,
  };
}

describe('dates locales', () => {
  it("retient le jour LOCAL de l'auteur, sans dérive UTC", () => {
    // 23h30 à Paris = 21h30 UTC : passer par toISOString() donnerait le bon jour ici,
    // mais 00h30 le 18 à Paris = 22h30 le 17 UTC ⇒ décalage d'un jour.
    expect(localDay('2026-08-17T23:30:00.000+02:00')).toBe('2026-08-17');
    expect(localDay('2026-08-18T00:30:00.000+02:00')).toBe('2026-08-18');
    // Contrôle : la conversion naïve se tromperait bien sur ce dernier cas.
    expect(new Date('2026-08-18T00:30:00.000+02:00').toISOString().slice(0, 10)).toBe('2026-08-17');
  });

  it("retient l'heure locale de l'auteur", () => {
    expect(localHour('2026-08-17T23:30:00.000+02:00')).toBe(23);
    expect(localHour('2026-08-17T09:05:00.000Z')).toBe(9);
    expect(localHour('2026-08-17T00:00:00.000-05:00')).toBe(0);
  });

  it('calcule le jour de semaine du jour local', () => {
    expect(localWeekday('2026-08-17T10:00:00.000+02:00')).toBe(1); // un lundi
    expect(localWeekday('2026-08-16T10:00:00.000+02:00')).toBe(0); // dimanche
  });
});

describe('ingestCommits', () => {
  it('agrège par (projet, auteur, jour)', () => {
    const resolver = new IdentityResolver();
    const result = ingestCommits('inst-a~42',
      [
        commit({ id: '1', stats: { additions: 10, deletions: 3, total: 13 } }),
        commit({ id: '2', stats: { additions: 5, deletions: 1, total: 6 } }),
        commit({
          id: '3',
          authored_date: '2026-08-18T09:00:00.000+02:00',
          committed_date: '2026-08-18T09:00:00.000+02:00',
          stats: { additions: 7, deletions: 0, total: 7 },
        }),
      ],
      resolver,
      new Set(),
    );

    expect(result.buckets).toHaveLength(2);
    const day17 = result.buckets.find((b) => b.day === '2026-08-17')!;
    expect(day17.projectKey).toBe('inst-a~42');
    expect(day17.commits).toBe(2);
    expect(day17.additions).toBe(15);
    expect(day17.deletions).toBe(4);
    expect(result.ingestedCount).toBe(3);
  });

  it('sépare les auteurs distincts', () => {
    const resolver = new IdentityResolver();
    const result = ingestCommits('inst-a~1',
      [
        commit({ id: '1' }),
        commit({ id: '2', author_name: 'Marie Durand', author_email: 'm.durand@example.com' }),
      ],
      resolver,
      new Set(),
    );
    expect(result.buckets).toHaveLength(2);
    expect(new Set(result.buckets.map((b) => b.authorId)).size).toBe(2);
  });

  it('regroupe les variantes d\'e-mail du même auteur', () => {
    const resolver = new IdentityResolver();
    const result = ingestCommits('inst-a~1',
      [
        commit({ id: '1', author_email: 'a.riviere@example.com' }),
        commit({ id: '2', author_email: 'A.Riviere+ci@Example.com', author_name: 'ariviere' }),
      ],
      resolver,
      new Set(),
    );
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]!.commits).toBe(2);
  });

  it('compte les merges à part sans les exclure du total', () => {
    const resolver = new IdentityResolver();
    const result = ingestCommits('inst-a~1',
      [commit({ id: '1' }), commit({ id: '2', parent_ids: ['b', 'c'] })],
      resolver,
      new Set(),
    );
    expect(result.buckets[0]!.commits).toBe(2);
    expect(result.buckets[0]!.merges).toBe(1);
  });

  it('ne compte AUCUNE ligne pour un commit de merge', () => {
    const resolver = new IdentityResolver();
    // GitLab renvoie ici le diff complet de la branche, dont les lignes ont déjà
    // été comptées commit par commit : les additionner doublerait le volume.
    const result = ingestCommits('inst-a~1',
      [
        commit({ id: '1', stats: { additions: 10, deletions: 4, total: 14 } }),
        commit({
          id: 'merge',
          parent_ids: ['b', 'c'],
          stats: { additions: 10, deletions: 4, total: 14 },
        }),
      ],
      resolver,
      new Set(),
    );
    expect(result.buckets[0]!.commits).toBe(2);
    expect(result.buckets[0]!.merges).toBe(1);
    expect(result.buckets[0]!.additions).toBe(10); // et non 20
    expect(result.buckets[0]!.deletions).toBe(4);
  });

  it('tolère l\'absence de stats (with_stats désactivé)', () => {
    const resolver = new IdentityResolver();
    const result = ingestCommits('inst-a~1', [commit({ id: '1', stats: undefined })], resolver, new Set());
    expect(result.buckets[0]!.additions).toBe(0);
    expect(result.buckets[0]!.deletions).toBe(0);
    expect(result.buckets[0]!.commits).toBe(1);
  });

  it('déduplique la zone de recouvrement des syncs incrémentaux', () => {
    const resolver = new IdentityResolver();
    // Le recouvrement d'une heure fait forcément revenir des commits déjà comptés :
    // sans dédup, ils seraient additionnés à chaque lancement.
    const result = ingestCommits('inst-a~1',
      [commit({ id: 'deja-vu' }), commit({ id: 'nouveau' })],
      resolver,
      new Set(['deja-vu']),
    );
    expect(result.ingestedCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.buckets[0]!.commits).toBe(1);
    expect(result.ingestedShas).toEqual(['nouveau']);
  });

  it('rattache au jour de la date d\'AUTEUR, pas de la date de commit', () => {
    const resolver = new IdentityResolver();
    // Cas d'un rebase : le travail date du 10, la réécriture du 17.
    const result = ingestCommits('inst-a~1',
      [
        commit({
          id: '1',
          authored_date: '2026-08-10T14:00:00.000+02:00',
          committed_date: '2026-08-17T09:00:00.000+02:00',
        }),
      ],
      resolver,
      new Set(),
    );
    expect(result.buckets[0]!.day).toBe('2026-08-10');
    // Mais le curseur d'incrémental suit la date de COMMIT, seule filtrée par l'API.
    expect(result.newestCommittedDate).toBe('2026-08-17T09:00:00.000+02:00');
  });

  it('renvoie les bornes de dates de commit pour le curseur', () => {
    const resolver = new IdentityResolver();
    const result = ingestCommits('inst-a~1',
      [
        commit({ id: '1', committed_date: '2026-08-17T10:00:00.000Z' }),
        commit({ id: '2', committed_date: '2026-08-01T10:00:00.000Z' }),
        commit({ id: '3', committed_date: '2026-08-09T10:00:00.000Z' }),
      ],
      resolver,
      new Set(),
    );
    expect(result.oldestCommittedDate).toBe('2026-08-01T10:00:00.000Z');
    expect(result.newestCommittedDate).toBe('2026-08-17T10:00:00.000Z');
  });

  it('construit les rythmes horaires et hebdomadaires', () => {
    const resolver = new IdentityResolver();
    const result = ingestCommits('inst-a~1',
      [
        commit({ id: '1', authored_date: '2026-08-17T23:30:00.000+02:00' }),
        commit({ id: '2', authored_date: '2026-08-17T23:45:00.000+02:00' }),
      ],
      resolver,
      new Set(),
    );
    expect(result.rhythms).toHaveLength(1);
    expect(result.rhythms[0]!.hours[23]).toBe(2);
    expect(result.rhythms[0]!.weekdays[1]).toBe(2); // lundi
  });

  it('produit les entrées du fil d\'activité', () => {
    const resolver = new IdentityResolver();
    const result = ingestCommits('inst-a~7', [commit({ id: 'abc', short_id: 'abc1234' })], resolver, new Set());
    expect(result.recentCommits[0]).toMatchObject({
      key: 'inst-a~7|abc',
      projectKey: 'inst-a~7',
      shortSha: 'abc1234',
      title: 'feat: quelque chose',
      isMerge: false,
    });
  });
});

describe('trimRecentShas', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');

  it('ne garde que la fenêtre de recouvrement', () => {
    const shas = trimRecentShas(
      [
        { sha: 'recent', date: '2026-08-16T12:00:00.000Z' },
        { sha: 'limite', date: '2026-08-11T12:00:00.000Z' },
        { sha: 'vieux', date: '2026-07-01T12:00:00.000Z' },
      ],
      now,
    );
    expect(shas).toEqual(['recent', 'limite']);
  });

  it('borne la taille pour ne pas gonfler indéfiniment IndexedDB', () => {
    const commits = Array.from({ length: 20_000 }, (_, i) => ({
      sha: `sha-${i}`,
      date: '2026-08-16T12:00:00.000Z',
    }));
    // Le plafond doit rester au-dessus du volume attendu sur la fenêtre de
    // recouvrement, sinon la déduplication devient partielle et les commits
    // sont recomptés.
    expect(trimRecentShas(commits, now)).toHaveLength(5_000);
  });

  it('couvre la même profondeur que le recouvrement du planner', () => {
    // Les deux fenêtres doivent coïncider : une rétention plus courte que le
    // recouvrement rouvrirait la porte au double comptage.
    const justInsideOverlap = new Date(now.getTime() - (OVERLAP_DAYS - 1) * 86_400_000).toISOString();
    const justOutside = new Date(now.getTime() - (OVERLAP_DAYS + 1) * 86_400_000).toISOString();
    const shas = trimRecentShas(
      [
        { sha: 'dedans', date: justInsideOverlap },
        { sha: 'dehors', date: justOutside },
      ],
      now,
    );
    expect(shas).toEqual(['dedans']);
  });
});
