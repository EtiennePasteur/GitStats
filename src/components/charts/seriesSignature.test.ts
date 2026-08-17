import { describe, it, expect } from 'vitest';
import { seriesSignature } from './seriesSignature';

const line = (id: string) => ({ type: 'line', id, name: id, stack: 'commits', data: [1, 2, 3] });

describe('seriesSignature — le bug des séries fantômes', () => {
  it('change quand une série disparaît', () => {
    // Le cas qui laissait une personne retirée affichée dans le comparateur :
    // une fusion garde les séries que la nouvelle option ne mentionne plus.
    const before = seriesSignature({ series: [line('a'), line('b'), line('c')] });
    const after = seriesSignature({ series: [line('b'), line('c')] });
    expect(after).not.toBe(before);
  });

  it('change quand une série en remplace une autre', () => {
    const before = seriesSignature({ series: [line('a'), line('b')] });
    const after = seriesSignature({ series: [line('z'), line('b')] });
    expect(after).not.toBe(before);
  });

  it('change quand seul l\'ordre change', () => {
    // À jeu identique mais réordonné, seule une reconstruction rend le nouvel
    // ordre d'empilement : la signature doit donc être sensible à l'ordre.
    expect(seriesSignature({ series: [line('a'), line('b')] })).not.toBe(
      seriesSignature({ series: [line('b'), line('a')] }),
    );
  });

  it('ne change pas quand seules les valeurs changent', () => {
    // C'est tout l'intérêt de la fusion : garder le survol et le zoom quand un
    // filtre ne fait que déplacer les valeurs.
    const before = seriesSignature({ series: [{ type: 'line', id: 'a', name: 'a', data: [1, 2] }] });
    const after = seriesSignature({ series: [{ type: 'line', id: 'a', name: 'a', data: [9, 9] }] });
    expect(after).toBe(before);
  });

  it('retombe sur le nom quand la série n\'a pas d\'identifiant', () => {
    expect(seriesSignature({ series: [{ type: 'bar', name: 'Commits' }] })).toBe('bar:Commits');
  });

  it('accepte une série unique, une absence de série, et des entrées non conformes', () => {
    expect(seriesSignature({ series: { type: 'pie', id: 'p' } })).toBe('pie:p');
    expect(seriesSignature({})).toBe('');
    expect(seriesSignature({ series: [] })).toBe('');
    expect(seriesSignature({ series: [null, 3] })).toBe('?\u0000?');
  });

  it('distingue deux séries dont les identifiants se concatèneraient', () => {
    // Sans séparateur, ['ab', 'c'] et ['a', 'bc'] donneraient la même signature.
    expect(seriesSignature({ series: [line('ab'), line('c')] })).not.toBe(
      seriesSignature({ series: [line('a'), line('bc')] }),
    );
  });
});
