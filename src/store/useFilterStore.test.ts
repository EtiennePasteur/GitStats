import { describe, it, expect } from 'vitest';
import { rangeForPreset, toFilters, useFilterStore } from './useFilterStore';
import { EMPTY_FILTERS } from '../query/selectors';

const EXTENT = { from: '2023-01-15', to: '2026-08-17' };

describe('rangeForPreset', () => {
  it("s'ancre sur la dernière journée couverte, pas sur aujourd'hui", () => {
    expect(rangeForPreset('7d', EXTENT)).toEqual({ from: '2026-08-11', to: '2026-08-17' });
    expect(rangeForPreset('30d', EXTENT)).toEqual({ from: '2026-07-19', to: '2026-08-17' });
  });

  it('décale les préréglages mensuels du bon nombre de mois', () => {
    expect(rangeForPreset('3m', EXTENT)).toEqual({ from: '2026-05-17', to: '2026-08-17' });
    expect(rangeForPreset('6m', EXTENT)).toEqual({ from: '2026-02-17', to: '2026-08-17' });
    expect(rangeForPreset('12m', EXTENT)).toEqual({ from: '2025-08-17', to: '2026-08-17' });
    expect(rangeForPreset('24m', EXTENT)).toEqual({ from: '2024-08-17', to: '2026-08-17' });
    expect(rangeForPreset('36m', EXTENT)).toEqual({ from: '2023-08-17', to: '2026-08-17' });
  });

  it('rogne le quantième au lieu de déborder sur le mois suivant', () => {
    // Un 31 reculé de 6 mois tombe sur un février inexistant : sans rognage la
    // borne basculait en mars et amputait la période de quelques jours.
    const endOfMonth = { from: '2020-01-01', to: '2026-08-31' };
    expect(rangeForPreset('6m', endOfMonth).from).toBe('2026-02-28');
    expect(rangeForPreset('3m', { from: '2020-01-01', to: '2026-05-31' }).from).toBe('2026-02-28');
    // Année bissextile : le 29 février existe, il doit être conservé.
    expect(rangeForPreset('12m', { from: '2020-01-01', to: '2025-02-28' }).from).toBe('2024-02-28');
    expect(rangeForPreset('24m', { from: '2020-01-01', to: '2026-02-28' }).from).toBe('2024-02-28');
  });

  it('« Tout » reprend les bornes des données et « personnalisé » les efface', () => {
    expect(rangeForPreset('all', EXTENT)).toEqual(EXTENT);
    expect(rangeForPreset('custom', EXTENT)).toEqual({ from: null, to: null });
  });

  it('ne propose aucune borne tant qu\'aucune donnée n\'est chargée', () => {
    expect(rangeForPreset('12m', { from: null, to: null })).toEqual({ from: null, to: null });
  });
});

describe('toFilters', () => {
  it('projette tous les champs de Filters, sans en oublier aucun', () => {
    // La projection est manuelle : un champ ajouté à `Filters` mais oublié ici
    // n'atteint jamais `filterBuckets`, et son interrupteur reste sans effet.
    const filters = toFilters(useFilterStore.getState());
    expect(Object.keys(filters).sort()).toEqual(Object.keys(EMPTY_FILTERS).sort());
    expect(filters.excludeMuted).toBe(true);
  });
});
