import { describe, expect, it } from 'vitest';
import { sequentialBreaks, sequentialRamp, type Palette } from './palette';

/**
 * Palette minimale : ces deux fonctions ne lisent que `sequential` et `grid`.
 * Les pas sont nommés pour que l'assertion dise quel pas a été retenu, plutôt
 * qu'un hexadécimal illisible.
 */
const palette = {
  series: [],
  sequential: ['seq-100', 'seq-200', 'seq-300', 'seq-400', 'seq-500', 'seq-600', 'seq-700'],
  grid: 'grid',
} as unknown as Palette;

describe('sequentialBreaks — les petites journées ne doivent pas passer pour du vide', () => {
  it('place le tout premier commit hors du gris, quelle que soit la période', () => {
    for (const max of [1, 7, 40, 500]) {
      expect(sequentialBreaks(max)[0]).toBe(1);
    }
  });

  it('répartit les paliers en racine et non linéairement', () => {
    // En linéaire, ce serait [1, 20, 40, 60, 80] : tout le bas de la
    // distribution — l'écrasante majorité des jours — dans un seul palier.
    expect(sequentialBreaks(100)).toEqual([1, 4, 16, 36, 64]);
  });

  it('donne la moitié des paliers au bas de la distribution', () => {
    const breaks = sequentialBreaks(400);
    expect(breaks).toEqual([1, 16, 64, 144, 256]);
    // Les trois premiers paliers couvrent moins du quart de l'amplitude.
    expect(breaks[3]!).toBeLessThan(400 / 2);
  });

  it('ne produit jamais deux paliers de même borne sur une période calme', () => {
    expect(sequentialBreaks(2)).toEqual([1, 2]);
    expect(sequentialBreaks(3)).toEqual([1, 2, 3]);
  });

  it('donne un palier par valeur quand le maximum est très bas', () => {
    expect(sequentialBreaks(4)).toEqual([1, 2, 3, 4]);
  });

  it('traite une période sans aucun commit comme un maximum de 1', () => {
    expect(sequentialBreaks(0)).toEqual([1]);
    expect(sequentialBreaks(-3)).toEqual([1]);
  });

  it('garde des bornes croissantes, plafonnées, et jamais au-delà du maximum', () => {
    for (let max = 1; max <= 500; max += 1) {
      const breaks = sequentialBreaks(max);
      expect(breaks[0]).toBe(1);
      expect(breaks.length).toBeLessThanOrEqual(5);
      expect(breaks[breaks.length - 1]!).toBeLessThanOrEqual(max);
      for (let i = 1; i < breaks.length; i += 1) {
        expect(breaks[i]!).toBeGreaterThan(breaks[i - 1]!);
      }
    }
  });
});

describe('sequentialRamp — une seule teinte, lisible sur les deux thèmes', () => {
  it('démarre au pas 300, jamais sur les deux pas les plus pâles', () => {
    // Sur le gris des cases vides, les pas 100 et 200 tiennent 1,00:1 et
    // 1,35:1 en thème clair : une journée à un commit y disparaîtrait.
    for (let count = 1; count <= 5; count += 1) {
      const ramp = sequentialRamp(count, palette);
      expect(ramp[0]).toBe('seq-300');
      expect(ramp).not.toContain('seq-100');
      expect(ramp).not.toContain('seq-200');
    }
  });

  it('couvre toute la fenêtre lisible quand les cinq paliers sont là', () => {
    expect(sequentialRamp(5, palette)).toEqual([
      'seq-300',
      'seq-400',
      'seq-500',
      'seq-600',
      'seq-700',
    ]);
  });

  it('étale les teintes quand il reste peu de paliers', () => {
    // Une période à deux commits garde un écart franc entre « 1 » et « 2 ».
    expect(sequentialRamp(2, palette)).toEqual(['seq-300', 'seq-700']);
    expect(sequentialRamp(3, palette)).toEqual(['seq-300', 'seq-500', 'seq-700']);
  });

  it('rend exactement autant de couleurs que de paliers', () => {
    for (let count = 1; count <= 5; count += 1) {
      expect(sequentialRamp(count, palette)).toHaveLength(count);
    }
  });
});
