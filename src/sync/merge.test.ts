import { describe, it, expect } from 'vitest';
import {
  flattenAliases,
  resolveAuthorId,
  mergeAuthorRecords,
  suggestMerges,
  nameTokens,
  IdentityResolver,
} from './identity';
import { filterBuckets, byAuthor, EMPTY_FILTERS } from '../query/selectors';
import { DEFAULT_SYNC_CONFIG, type StoredAuthor, type DailyBucket, type StoredProject } from '../model/types';

const BOTS = DEFAULT_SYNC_CONFIG.botPatterns;

function author(id: string, displayName: string, knownNames: string[] = []): StoredAuthor {
  return {
    id,
    displayName,
    primaryEmail: id,
    identityKeys: [id],
    knownNames: knownNames.length > 0 ? knownNames : [displayName],
    knownEmails: [id],
    isBot: false,
  };
}

describe('nameTokens', () => {
  it('normalise et retire les particules', () => {
    expect(nameTokens('Amélie Rivière')).toEqual(['amelie', 'riviere']);
    expect(nameTokens('Jean de La Fontaine')).toEqual(['jean', 'fontaine']);
    expect(nameTokens('Karim  Ben-Ali')).toEqual(['karim', 'ben', 'ali']);
  });
});

describe('suggestMerges — rapprochement par nom et prénom', () => {
  it('rapproche un mail pro et un mail perso portant le même nom', () => {
    // Le cas visé : rien de commun dans les adresses, seul l'état civil relie.
    const suggestions = suggestMerges([
      author('a.riviere@example.com', 'Amélie Rivière'),
      author('amelie.riviere@example.net', 'Amelie RIVIERE'),
    ]);
    const names = suggestions.filter((s) => s.kind === 'name');
    expect(names).toHaveLength(1);
    expect(names[0]!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(names[0]!.reason).toContain('Amélie Rivière');
  });

  it('rapproche un nom écrit dans l\'ordre inverse', () => {
    const suggestions = suggestMerges([
      author('a@example.com', 'Amélie Rivière'),
      author('b@example.net', 'RIVIERE Amelie'),
    ]);
    expect(suggestions.some((s) => s.kind === 'name')).toBe(true);
  });

  it('rapproche une initiale au prénom complet', () => {
    const suggestions = suggestMerges([
      author('a@example.com', 'Amélie Rivière'),
      author('b@example.net', 'A. Rivière'),
    ]);
    const match = suggestions.find((s) => s.kind === 'name');
    expect(match).toBeDefined();
    expect(match!.reason).toContain('abrégé');
  });

  it('utilise aussi les autres noms croisés dans les commits', () => {
    // Le nom affiché diffère, mais l'une des variantes correspond.
    const suggestions = suggestMerges([
      author('a@example.com', 'ariviere', ['ariviere', 'Amélie Rivière']),
      author('b@example.net', 'Amelie Riviere'),
    ]);
    expect(suggestions.some((s) => s.kind === 'name')).toBe(true);
  });

  it('NE rapproche PAS deux prénoms différents sur le même patronyme', () => {
    // Frère et sœur, conjoints, homonymes : ce sont des personnes distinctes.
    const suggestions = suggestMerges([
      author('a@example.com', 'Amélie Rivière'),
      author('b@example.com', 'Marc Rivière'),
    ]);
    expect(suggestions).toEqual([]);
  });

  it('NE rapproche PAS sur un mot unique', () => {
    // « admin », « dev », « build » rapprocheraient n'importe qui.
    const suggestions = suggestMerges([
      author('a@example.com', 'admin'),
      author('b@example.com', 'admin'),
    ]);
    expect(suggestions.filter((s) => s.kind === 'name')).toEqual([]);
  });

  it('ne propose qu\'UNE entrée par couple, avec le meilleur indice', () => {
    const suggestions = suggestMerges([
      author('a.riviere@example.com', 'Amélie Rivière'),
      author('a.riviere@example.org', 'Amélie Rivière'),
    ]);
    expect(suggestions).toHaveLength(1);
    // L'indice e-mail (0.9) l'emporte sur l'indice nom (0.88).
    expect(suggestions[0]!.kind).toBe('email');
  });

  it('ignore les bots', () => {
    const bot = { ...author('gitlab-ci@example.com', 'GitLab CI'), isBot: true };
    const bot2 = { ...author('gitlab-ci@example.org', 'GitLab CI'), isBot: true };
    expect(suggestMerges([bot, bot2])).toEqual([]);
  });
});

describe('flattenAliases', () => {
  it('aplatit les chaînes de fusion', () => {
    // Sans aplatissement, « c » resterait rattaché à « b » et la personne
    // apparaîtrait encore en double.
    const flat = flattenAliases({ c: 'b', b: 'a' });
    expect(flat.get('c')).toBe('a');
    expect(flat.get('b')).toBe('a');
    expect(resolveAuthorId('a', flat)).toBe('a');
  });

  it('rompt les cycles au lieu de boucler', () => {
    const flat = flattenAliases({ a: 'b', b: 'a' });
    // Peu importe le représentant élu, la résolution doit terminer et être stable.
    expect(flat.size).toBeGreaterThan(0);
    const ra = resolveAuthorId('a', flat);
    expect(resolveAuthorId(ra, flat)).toBe(ra);
  });

  it('ignore une auto-référence', () => {
    expect(flattenAliases({ a: 'a' }).size).toBe(0);
  });
});

describe('mergeAuthorRecords', () => {
  it('rassemble e-mails, noms et clés sur la fiche survivante', () => {
    const merged = mergeAuthorRecords(
      [
        author('a.riviere@example.com', 'Amélie Rivière'),
        author('amelie.riviere@example.net', 'Amelie RIVIERE'),
      ],
      flattenAliases({ 'amelie.riviere@example.net': 'a.riviere@example.com' }),
    );

    expect(merged.size).toBe(1);
    const person = merged.get('a.riviere@example.com')!;
    expect(person.displayName).toBe('Amélie Rivière');
    expect(person.knownEmails).toEqual(['a.riviere@example.com', 'amelie.riviere@example.net']);
    expect(person.identityKeys).toHaveLength(2);
    expect(person.manual).toBe(true);
  });

  it('ne mute pas les fiches d\'origine', () => {
    const source = author('b@x.fr', 'B');
    mergeAuthorRecords([author('a@x.fr', 'A'), source], flattenAliases({ 'b@x.fr': 'a@x.fr' }));
    expect(source.identityKeys).toEqual(['b@x.fr']);
  });

  it('une personne absorbant un compte technique ne devient pas un bot', () => {
    const bot = { ...author('svc@x.fr', 'Service'), isBot: true };
    const merged = mergeAuthorRecords(
      [author('a@x.fr', 'Alice'), bot],
      flattenAliases({ 'svc@x.fr': 'a@x.fr' }),
    );
    expect(merged.get('a@x.fr')!.isBot).toBe(false);
  });
});

describe('fusion appliquée à la lecture', () => {
  const projects = new Map<string, StoredProject>();

  const PROJECT = 'inst-a~1';
  function bucket(authorId: string, day: string, commits: number): DailyBucket {
    return {
      key: `${PROJECT}|${authorId}|${day}`,
      projectKey: PROJECT,
      authorId,
      day,
      commits,
      additions: commits * 10,
      deletions: commits,
      merges: 0,
    };
  }

  const raw = [
    bucket('a.riviere@example.com', '2026-08-17', 3),
    bucket('amelie.riviere@example.net', '2026-08-17', 2),
    bucket('amelie.riviere@example.net', '2026-08-18', 4),
  ];

  const aliases = flattenAliases({ 'amelie.riviere@example.net': 'a.riviere@example.com' });
  const authors = mergeAuthorRecords(
    [author('a.riviere@example.com', 'Amélie Rivière'), author('amelie.riviere@example.net', 'Amelie R')],
    aliases,
  );

  it('regroupe les deux adresses en une seule personne, sans re-synchroniser', () => {
    const filtered = filterBuckets(raw, EMPTY_FILTERS, authors, projects, aliases);
    const stats = byAuthor(filtered);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.authorId).toBe('a.riviere@example.com');
    expect(stats[0]!.commits).toBe(9);
    // Deux journées distinctes, malgré trois seaux.
    expect(stats[0]!.activeDays).toBe(2);
  });

  it('ne perd aucun commit et ne mute pas les seaux stockés', () => {
    const before = raw.map((b) => ({ ...b }));
    const filtered = filterBuckets(raw, EMPTY_FILTERS, authors, projects, aliases);
    expect(filtered.reduce((sum, b) => sum + b.commits, 0)).toBe(9);
    expect(raw).toEqual(before);
  });

  it('reste réversible : sans alias, les deux personnes reviennent', () => {
    const resolver = new IdentityResolver();
    resolver.observe({ name: 'Amélie Rivière', email: 'a.riviere@example.com' }, 1);
    resolver.observe({ name: 'Amelie R', email: 'amelie.riviere@example.net' }, 1);
    const separate = new Map(resolver.toAuthors(BOTS).map((a) => [a.id, a]));

    const filtered = filterBuckets(raw, EMPTY_FILTERS, separate, projects, new Map());
    expect(byAuthor(filtered)).toHaveLength(2);
  });

  it('un filtre par personne ramène les commits de TOUTES ses adresses', () => {
    const filtered = filterBuckets(
      raw,
      { ...EMPTY_FILTERS, authorIds: new Set(['a.riviere@example.com']) },
      authors,
      projects,
      aliases,
    );
    expect(filtered.reduce((sum, b) => sum + b.commits, 0)).toBe(9);
  });
});
