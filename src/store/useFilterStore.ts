/**
 * Filtres globaux. Une seule barre de filtres pilote TOUTES les vues : aucun
 * filtre n'est propre à une carte, sinon deux graphiques côte à côte peuvent
 * afficher des périmètres différents sans que le lecteur s'en rende compte.
 */

import { create } from 'zustand';
import { EMPTY_FILTERS, type Filters } from '../query/selectors';
import type { ProjectKey } from '../model/types';

export type DatePreset = '7d' | '30d' | '3m' | '6m' | '12m' | '24m' | '36m' | 'all' | 'custom';

interface FilterState extends Filters {
  preset: DatePreset;
  setPreset: (preset: DatePreset, extent: { from: string | null; to: string | null }) => void;
  setRange: (from: string | null, to: string | null) => void;
  setProjectKeys: (keys: ReadonlySet<ProjectKey> | null) => void;
  setInstanceIds: (ids: ReadonlySet<string> | null) => void;
  setAuthorIds: (ids: ReadonlySet<string> | null) => void;
  setNamespaces: (paths: ReadonlySet<string> | null) => void;
  setSearch: (search: string) => void;
  toggleBots: () => void;
  toggleMerges: () => void;
  toggleMuted: () => void;
  reset: (extent: { from: string | null; to: string | null }) => void;
}

function shiftDays(days: number, to: string): string {
  const date = new Date(`${to}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days + 1);
  return date.toISOString().slice(0, 10);
}

function shiftMonths(months: number, to: string): string {
  const date = new Date(`${to}T00:00:00Z`);
  const day = date.getUTCDate();
  // Reculer d'abord au 1ᵉʳ : `setUTCMonth` appliqué à un 29–31 déborde sur le
  // mois suivant quand le mois visé est plus court (31 août − 6 mois donnerait
  // le 3 mars). On recale ensuite le quantième, rogné sur la fin du mois.
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

export function rangeForPreset(
  preset: DatePreset,
  extent: { from: string | null; to: string | null },
): { from: string | null; to: string | null } {
  // Les préréglages s'ancrent sur la dernière journée COUVERTE par les données,
  // pas sur aujourd'hui : après un import de fichier vieux d'une semaine,
  // « 7 derniers jours » doit rester lisible et non vide.
  const to = extent.to;
  if (to === null) return { from: null, to: null };
  switch (preset) {
    case '7d':
      return { from: shiftDays(7, to), to };
    case '30d':
      return { from: shiftDays(30, to), to };
    case '3m':
      return { from: shiftMonths(3, to), to };
    case '6m':
      return { from: shiftMonths(6, to), to };
    case '12m':
      return { from: shiftMonths(12, to), to };
    case '24m':
      return { from: shiftMonths(24, to), to };
    case '36m':
      return { from: shiftMonths(36, to), to };
    case 'all':
      return { from: extent.from, to };
    case 'custom':
      return { from: null, to: null };
  }
}

export const useFilterStore = create<FilterState>((set) => ({
  ...EMPTY_FILTERS,
  preset: 'all',

  setPreset: (preset, extent) => {
    if (preset === 'custom') {
      set({ preset });
      return;
    }
    const { from, to } = rangeForPreset(preset, extent);
    set({ preset, from, to });
  },
  setRange: (from, to) => set({ from, to, preset: 'custom' }),
  setProjectKeys: (projectKeys) => set({ projectKeys }),
  setInstanceIds: (instanceIds) => set({ instanceIds }),
  setAuthorIds: (authorIds) => set({ authorIds }),
  setNamespaces: (namespaces) => set({ namespaces }),
  setSearch: (search) => set({ search }),
  toggleBots: () => set((state) => ({ excludeBots: !state.excludeBots })),
  toggleMerges: () => set((state) => ({ excludeMerges: !state.excludeMerges })),
  toggleMuted: () => set((state) => ({ excludeMuted: !state.excludeMuted })),
  reset: (extent) =>
    set({
      ...EMPTY_FILTERS,
      preset: 'all',
      ...rangeForPreset('all', extent),
    }),
}));

/** Extrait la partie « Filters » pure du store, pour la passer aux sélecteurs. */
export function toFilters(state: FilterState): Filters {
  return {
    from: state.from,
    to: state.to,
    projectKeys: state.projectKeys,
    instanceIds: state.instanceIds,
    authorIds: state.authorIds,
    namespaces: state.namespaces,
    excludeBots: state.excludeBots,
    excludeMerges: state.excludeMerges,
    excludeMuted: state.excludeMuted,
    search: state.search,
  };
}
