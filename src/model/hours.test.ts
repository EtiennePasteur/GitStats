import { describe, it, expect } from 'vitest';
import { addHour, mergeHours, subtractHours, unpackHours, sumHours, sanitizeHours } from './hours';

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

  it('traite une répartition inconnue comme une répartition vide', () => {
    // Un seau ancien qui reçoit de nouveaux commits devient partiellement
    // couvert plutôt que de perdre les heures fraîchement collectées.
    expect(mergeHours(undefined, [9, 1])).toEqual([9, 1]);
    expect(mergeHours([9, 1], undefined)).toEqual([9, 1]);
    expect(mergeHours(undefined, undefined)).toBeUndefined();
  });

  it('renvoie une copie et jamais la référence reçue', () => {
    const source = [9, 1];
    expect(mergeHours(undefined, source)).not.toBe(source);
    expect(subtractHours(source, undefined)).not.toBe(source);
  });

  it('soustrait en saturant à zéro', () => {
    expect(subtractHours([9, 3, 14, 1], [9, 1])).toEqual([9, 2, 14, 1]);
    expect(subtractHours([9, 1, 14, 1], [9, 5])).toEqual([14, 1]);
  });

  it('rend une répartition inconnue quand la soustraction annule tout', () => {
    expect(subtractHours([9, 1], [9, 1])).toBeUndefined();
    expect(subtractHours(undefined, [9, 1])).toBeUndefined();
  });

  it('compte les commits dont l\'heure est connue', () => {
    expect(sumHours([9, 3, 14, 1])).toBe(4);
    expect(sumHours(undefined)).toBe(0);
  });

  it('déplie sur 24 cases pour le graphique', () => {
    const dense = unpackHours([9, 3, 23, 1]);
    expect(dense).toHaveLength(24);
    expect(dense[9]).toBe(3);
    expect(dense[23]).toBe(1);
    expect(dense[0]).toBe(0);
  });

  it('écarte une répartition mal formée venue d\'un fichier édité à la main', () => {
    expect(sanitizeHours([9, 1, 14])).toBeUndefined(); // longueur impaire
    expect(sanitizeHours('9,1')).toBeUndefined();
    expect(sanitizeHours([])).toBeUndefined();
    expect(sanitizeHours([24, 1])).toBeUndefined(); // heure hors bornes
    expect(sanitizeHours([-1, 1])).toBeUndefined();
    expect(sanitizeHours([9, 0])).toBeUndefined(); // compteur nul
  });

  it('normalise une répartition valide mais désordonnée', () => {
    expect(sanitizeHours([14, 1, 9, 2, 9, 1])).toEqual([9, 3, 14, 1]);
  });
});
