import { describe, it, expect } from 'vitest';
import { disambiguateLabels } from './labels';

const entry = (id: string, name: string, hint: string | null = id) => ({ id, name, hint });

describe('disambiguateLabels', () => {
  it('laisse le nom nu quand il est unique', () => {
    const labels = disambiguateLabels([
      entry('a.riviere@example.com', 'Amélie Rivière'),
      entry('p.martin@example.com', 'Paul Martin'),
    ]);
    expect(labels.get('a.riviere@example.com')).toBe('Amélie Rivière');
    expect(labels.get('p.martin@example.com')).toBe('Paul Martin');
  });

  it('départage deux identités non fusionnées qui portent le même nom', () => {
    // Sans cela, la légende ECharts — indexée par nom de série — repliait les
    // deux courbes sur une seule entrée : deux aires, une seule étiquette.
    const labels = disambiguateLabels([
      entry('a.riviere@example.com', 'Amélie Rivière'),
      entry('ariviere@example.org', 'Amélie Rivière'),
    ]);
    expect(labels.get('a.riviere@example.com')).toBe('Amélie Rivière (a.riviere@example.com)');
    expect(labels.get('ariviere@example.org')).toBe('Amélie Rivière (ariviere@example.org)');
    expect(new Set(labels.values()).size).toBe(2);
  });

  it('ne désambiguïse que les noms en collision', () => {
    const labels = disambiguateLabels([
      entry('a.riviere@example.com', 'Amélie Rivière'),
      entry('ariviere@example.org', 'Amélie Rivière'),
      entry('p.martin@example.com', 'Paul Martin'),
    ]);
    expect(labels.get('p.martin@example.com')).toBe('Paul Martin');
  });

  it('garde le nom nu plutôt qu\'une parenthèse vide quand l\'indice manque', () => {
    const labels = disambiguateLabels([
      entry('un', 'Amélie Rivière', null),
      entry('deux', 'Amélie Rivière', ''),
    ]);
    expect(labels.get('un')).toBe('Amélie Rivière');
    expect(labels.get('deux')).toBe('Amélie Rivière');
  });

  it('couvre trois homonymes', () => {
    const labels = disambiguateLabels([
      entry('un', 'Amélie Rivière'),
      entry('deux', 'Amélie Rivière'),
      entry('trois', 'Amélie Rivière'),
    ]);
    expect(new Set(labels.values()).size).toBe(3);
  });
});
