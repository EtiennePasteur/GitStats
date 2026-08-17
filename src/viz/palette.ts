/**
 * Attribution des couleurs de série.
 *
 * Règle non négociable : **la couleur suit l'entité, jamais son rang.** Si les
 * teintes étaient distribuées dans l'ordre du classement courant, filtrer une
 * personne repeindrait toutes les autres — et le lecteur qui avait retenu
 * « Étienne = bleu » se retrouve à lire un graphique qui ment.
 *
 * D'où la mécanique en deux temps :
 *  1. une carte de couleurs est calculée pour un PÉRIMÈTRE (global, un projet,
 *     une personne) à partir des volumes NON filtrés ;
 *  2. les filtres de l'utilisateur (dates, bots, merges) changent ce qui est
 *     affiché, jamais l'attribution.
 *
 * Au-delà de 8 séries on ne génère pas de teinte : le reste bascule dans
 * « Autres », en gris. Une 9ᵉ couleur serait indiscernable d'une existante en
 * vision daltonienne.
 */

/** Emplacements catégoriels, ordre fixe et validé (voir styles/index.css). */
export const SERIES_SLOTS = 8;

export const OTHER_COLOR = 'var(--text-muted)';
export const OTHER_LABEL = 'Autres';

export function seriesVar(index: number): string {
  return `var(--series-${(index % SERIES_SLOTS) + 1})`;
}

/**
 * Résout une variable CSS en couleur concrète — ECharts sait dessiner avec
 * `var(...)` dans certains contextes mais pas dans les dégradés ni les canvas
 * exports, donc on résout systématiquement.
 */
export function readCssColor(name: string, fallback = '#888888'): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

export interface Palette {
  series: string[];
  sequential: string[];
  divergingPositive: string;
  divergingNegative: string;
  surface: string;
  surfaceRaised: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  grid: string;
  axis: string;
  other: string;
  status: { good: string; warning: string; serious: string; critical: string };
}

export function readPalette(): Palette {
  return {
    series: Array.from({ length: SERIES_SLOTS }, (_, i) => readCssColor(`--series-${i + 1}`)),
    sequential: [100, 200, 300, 400, 500, 600, 700].map((step) => readCssColor(`--seq-${step}`)),
    divergingPositive: readCssColor('--div-pos'),
    divergingNegative: readCssColor('--div-neg'),
    surface: readCssColor('--surface-1', '#1a1a19'),
    surfaceRaised: readCssColor('--surface-2', '#222221'),
    textPrimary: readCssColor('--text-primary', '#ffffff'),
    textSecondary: readCssColor('--text-secondary', '#c3c2b7'),
    textMuted: readCssColor('--text-muted', '#898781'),
    grid: readCssColor('--grid', '#2c2c2a'),
    axis: readCssColor('--axis', '#383835'),
    other: readCssColor('--text-muted', '#898781'),
    status: {
      good: readCssColor('--status-good', '#0ca30c'),
      warning: readCssColor('--status-warning', '#fab219'),
      serious: readCssColor('--status-serious', '#ec835a'),
      critical: readCssColor('--status-critical', '#d03b3b'),
    },
  };
}

export interface ColorAssignment {
  /** id d'entité → couleur. Les entités hors top-8 sont absentes. */
  byId: Map<string, string>;
  /** Les ids ayant reçu un emplacement, dans l'ordre. */
  named: string[];
  /** Les ids repliés dans « Autres ». */
  others: string[];
  colorOf: (id: string) => string;
}

/**
 * @param rankedIds ids triés par volume sur le PÉRIMÈTRE non filtré.
 */
export function assignColors(rankedIds: string[], palette: Palette): ColorAssignment {
  const byId = new Map<string, string>();
  const named: string[] = [];
  const others: string[] = [];

  rankedIds.forEach((id, index) => {
    if (index < SERIES_SLOTS) {
      byId.set(id, palette.series[index] ?? palette.other);
      named.push(id);
    } else {
      others.push(id);
    }
  });

  return {
    byId,
    named,
    others,
    colorOf: (id: string) => byId.get(id) ?? palette.other,
  };
}

/** Rampe séquentielle : magnitude continue, une seule teinte clair → foncé. */
export function sequentialColor(value: number, max: number, palette: Palette): string {
  if (max <= 0 || value <= 0) return palette.grid;
  const steps = palette.sequential;
  // Échelle en racine : les distributions d'activité Git sont très asymétriques
  // (quelques jours énormes, beaucoup de jours calmes). En linéaire, tout le
  // calendrier serait de la teinte la plus pâle.
  const ratio = Math.sqrt(Math.min(1, value / max));
  const index = Math.min(steps.length - 1, Math.max(0, Math.round(ratio * (steps.length - 1))));
  return steps[index] ?? palette.grid;
}
