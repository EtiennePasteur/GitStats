import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  normalizeEmail,
  identityKey,
  isBotIdentity,
  IdentityResolver,
  suggestMerges,
} from './identity';
import { DEFAULT_SYNC_CONFIG } from '../model/types';

const BOTS = DEFAULT_SYNC_CONFIG.botPatterns;

describe('normalizeName', () => {
  it('retire accents, casse et ponctuation', () => {
    expect(normalizeName('Amélie Rivière')).toBe('amelie riviere');
    expect(normalizeName('  JEAN-FRANÇOIS   Müller ')).toBe('jean francois muller');
    expect(normalizeName('Rémy Côté')).toBe('remy cote');
  });
});

describe('normalizeEmail', () => {
  it('normalise la casse et les espaces', () => {
    expect(normalizeEmail('  Amelie.Riviere@Example.COM ')).toBe('amelie.riviere@example.com');
  });

  it('supprime le sous-adressage +tag', () => {
    expect(normalizeEmail('dev+gitlab@example.com')).toBe('dev@example.com');
  });

  it('réduit les e-mails noreply à leur login', () => {
    expect(normalizeEmail('12345-ariviere@users.noreply.gitlab.com')).toBe('noreply:ariviere');
    expect(normalizeEmail('ariviere@users.noreply.gitlab.com')).toBe('noreply:ariviere');
    // Deux formes noreply du même compte doivent converger.
    expect(normalizeEmail('999-ariviere@users.noreply.gitlab.com')).toBe(
      normalizeEmail('ariviere@users.noreply.gitlab.com'),
    );
  });

  it('tolère une saisie sans arobase', () => {
    expect(normalizeEmail('root')).toBe('root');
    expect(normalizeEmail('')).toBe('');
  });
});

describe('identityKey', () => {
  it("se rabat sur le nom quand l'e-mail est vide", () => {
    expect(identityKey({ name: 'Amélie Rivière', email: '' })).toBe('name:amelie riviere');
    expect(identityKey({ name: '', email: '' })).toBe('unknown');
  });

  it('ignore les variations de nom si l\'e-mail est le même', () => {
    const a = identityKey({ name: 'Amelie Riviere', email: 'a.riviere@example.com' });
    const b = identityKey({ name: 'ariviere', email: 'A.Riviere@Example.com' });
    expect(a).toBe(b);
  });
});

describe('isBotIdentity', () => {
  it('repère les comptes techniques courants', () => {
    expect(isBotIdentity({ name: 'GitLab CI', email: 'gitlab-ci@example.com' }, BOTS)).toBe(true);
    expect(isBotIdentity({ name: 'Jenkins', email: 'svc_jenkins@example.com' }, BOTS)).toBe(true);
    expect(isBotIdentity({ name: 'renovate[bot]', email: 'renovate@x.io' }, BOTS)).toBe(true);
    expect(isBotIdentity({ name: 'X', email: '1-y@users.noreply.gitlab.com' }, BOTS)).toBe(true);
  });

  it("ne prend pas un humain pour un robot (le faux positif efface une vraie personne)", () => {
    expect(isBotIdentity({ name: 'Sylvie Bottin', email: 's.bottin@example.com' }, BOTS)).toBe(false);
    expect(isBotIdentity({ name: 'Marc Abbott', email: 'm.abbott@example.com' }, BOTS)).toBe(false);
    expect(isBotIdentity({ name: 'Amélie Rivière', email: 'a.riviere@example.com' }, BOTS)).toBe(false);
  });
});

describe('IdentityResolver', () => {
  it('regroupe les variantes de nom sous un seul e-mail et élit le nom majoritaire', () => {
    const resolver = new IdentityResolver();
    resolver.observe({ name: 'a.riviere', email: 'a.riviere@example.com' }, 3);
    resolver.observe({ name: 'Amélie Rivière', email: 'A.Riviere@example.com' }, 40);
    resolver.observe({ name: 'amelie', email: 'a.riviere+ci@example.com' }, 1);

    const authors = resolver.toAuthors(BOTS);
    expect(authors).toHaveLength(1);
    expect(authors[0]!.displayName).toBe('Amélie Rivière'); // le plus « lourd » en commits
    expect(authors[0]!.knownNames).toHaveLength(3);
  });

  it('ne fusionne PAS deux e-mails différents tout seul', () => {
    const resolver = new IdentityResolver();
    resolver.observe({ name: 'Amélie Rivière', email: 'a.riviere@example.com' }, 10);
    resolver.observe({ name: 'Amélie Rivière', email: 'amelie.riviere@example.net' }, 5);
    // Deux personnes tant qu'un humain n'a pas confirmé : fusionner à tort est
    // pire que de laisser deux entrées.
    expect(resolver.toAuthors(BOTS)).toHaveLength(2);
  });

  it('applique les fusions manuelles et les fait gagner', () => {
    const canonical = 'a.riviere@example.com';
    const resolver = new IdentityResolver({ 'amelie.riviere@example.net': canonical });
    resolver.observe({ name: 'Amélie Rivière', email: canonical }, 10);
    resolver.observe({ name: 'Amelie R', email: 'amelie.riviere@example.net' }, 50);

    const authors = resolver.toAuthors(BOTS, { 'amelie.riviere@example.net': canonical });
    expect(authors).toHaveLength(1);
    // La racine imposée manuellement l'emporte, même si l'autre pèse plus lourd.
    expect(authors[0]!.id).toBe(canonical);
    expect(authors[0]!.identityKeys).toEqual([canonical, 'amelie.riviere@example.net']);
    expect(authors[0]!.manual).toBe(true);
  });

  it('reste cohérent sur des fusions en chaîne', () => {
    const resolver = new IdentityResolver({ b: 'a', c: 'b' });
    resolver.observe({ name: 'A', email: 'a' }, 1);
    resolver.observe({ name: 'B', email: 'b' }, 1);
    resolver.observe({ name: 'C', email: 'c' }, 1);
    const authors = resolver.toAuthors(BOTS, { b: 'a', c: 'b' });
    expect(authors).toHaveLength(1);
    expect(authors[0]!.identityKeys.sort()).toEqual(['a', 'b', 'c']);
  });

  it('marque les bots sans les supprimer', () => {
    const resolver = new IdentityResolver();
    resolver.observe({ name: 'GitLab CI', email: 'gitlab-ci@example.com' }, 900);
    resolver.observe({ name: 'Amélie Rivière', email: 'a.riviere@example.com' }, 10);
    const authors = resolver.toAuthors(BOTS);
    expect(authors.filter((a) => a.isBot)).toHaveLength(1);
    expect(authors).toHaveLength(2);
  });
});

describe('suggestMerges', () => {
  const build = (pairs: Array<[string, string]>) => {
    const resolver = new IdentityResolver();
    for (const [name, email] of pairs) resolver.observe({ name, email }, 5);
    return resolver.toAuthors(BOTS);
  };

  it('propose la même partie locale sur deux domaines', () => {
    const authors = build([
      ['Amélie Rivière', 'a.riviere@example.com'],
      ['A. Rivière', 'a.riviere@example.org'],
    ]);
    const suggestions = suggestMerges(authors);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('propose les noms affichés identiques', () => {
    const authors = build([
      ['Amélie Rivière', 'a@example.com'],
      ['Amelie RIVIERE', 'b@example.net'],
    ]);
    expect(suggestMerges(authors)[0]?.reason).toContain('Même nom affiché');
  });

  it('rattache un login à un nom complet', () => {
    const authors = build([
      ['Amélie Rivière', 'x@example.com'],
      ['ariviere', 'ariviere@example.com'],
    ]);
    const suggestions = suggestMerges(authors);
    expect(suggestions.some((s) => s.reason.includes('correspond à'))).toBe(true);
  });

  it('ne propose rien pour des personnes clairement distinctes', () => {
    const authors = build([
      ['Amélie Rivière', 'a.riviere@example.com'],
      ['Marie Durand', 'm.durand@example.com'],
      ['Paul Martin', 'p.martin@example.com'],
    ]);
    expect(suggestMerges(authors)).toEqual([]);
  });

  it('ignore les bots dans les propositions', () => {
    const authors = build([
      ['GitLab CI', 'gitlab-ci@example.com'],
      ['GitLab CI', 'gitlab-ci@example.org'],
    ]);
    expect(suggestMerges(authors)).toEqual([]);
  });

  it('ne produit jamais de doublon de paire', () => {
    const authors = build([
      ['Amélie Rivière', 'a.riviere@example.com'],
      ['Amélie Rivière', 'a.riviere@example.org'],
    ]);
    // Deux indices matchent (même local ET même nom) : une seule suggestion.
    expect(suggestMerges(authors)).toHaveLength(1);
  });
});
