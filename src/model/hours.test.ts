import { describe, it, expect } from 'vitest';
import { addHour, mergeHours, subtractHours, sumHours, sanitizeHours } from './hours';

describe('répartition horaire', () => {
  it('insère une heure en gardant les paires triées', () => {
    const packed: number[] = [];
    addHour(packed, 14);
    addHour(packed, 9);
    addHour(packed, 23);
    addHour(packed, 9, 2);
    // La forme triée est canonique : deux répartitions égales le sont au sens strict.
    expect(packed).toEqual([9, 3, 14, 1, 23, 1]);
  });

  it('additionne deux répartitions sans muter ses arguments', () => {
    const a = [9, 2, 14, 1];
    const b = [10, 5, 14, 3];
    expect(mergeHours(a, b)).toEqual([9, 2, 10, 5, 14, 4]);
    expect(a).toEqual([9, 2, 14, 1]);
    expect(b).toEqual([10, 5, 14, 3]);
  });

  it('renvoie une copie et jamais la référence reçue', () => {
    const source = [9, 1];
    expect(mergeHours([], source)).not.toBe(source);
    expect(subtractHours(source, [])).not.toBe(source);
  });

  it('soustrait en saturant à zéro', () => {
    expect(subtractHours([9, 3, 14, 1], [9, 1])).toEqual([9, 2, 14, 1]);
    expect(subtractHours([9, 1, 14, 1], [9, 5])).toEqual([14, 1]);
  });

  it('rend une répartition vide quand la soustraction annule tout', () => {
    expect(subtractHours([9, 1], [9, 1])).toEqual([]);
  });

  it('compte les commits portés par la répartition', () => {
    expect(sumHours([9, 3, 14, 1])).toBe(4);
    expect(sumHours([])).toBe(0);
  });

  it('écarte une répartition mal formée venue d\'un fichier édité à la main', () => {
    expect(sanitizeHours([9, 1, 14])).toEqual([]); // longueur impaire
    expect(sanitizeHours('9,1')).toEqual([]);
    expect(sanitizeHours([24, 1])).toEqual([]); // heure hors bornes
    expect(sanitizeHours([-1, 1])).toEqual([]);
    expect(sanitizeHours([9, 0])).toEqual([]); // compteur nul
  });

  it('normalise une répartition valide mais désordonnée', () => {
    expect(sanitizeHours([14, 1, 9, 2, 9, 1])).toEqual([9, 3, 14, 1]);
  });
});
