/**
 * Les graphiques de l'application.
 *
 * Contraintes tenues partout :
 *  - un seul axe des ordonnées, jamais deux échelles sur un même tracé ;
 *  - légende présente dès 2 séries, jamais pour une seule (le titre la nomme) ;
 *  - étiquetage direct sélectif, jamais une valeur sur chaque point ;
 *  - écart de 2 px entre remplissages empilés au lieu d'une bordure ;
 *  - empilement réservé aux lectures de composition ; comparer des entités
 *    entre elles demande des courbes partant toutes de zéro ;
 *  - infobulle systématique, et une vue tableau équivalente à côté ;
 *  - couleur attribuée par entité, jamais par rang.
 */

import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import { EChart, axisStyle, tooltipStyle } from './EChart';
import type { Palette, ColorAssignment } from '../../viz/palette';
import { sequentialColor, sequentialBreaks, sequentialRamp, OTHER_LABEL } from '../../viz/palette';
import { OTHER_SERIES_ID, type DayPoint, type Granularity } from '../../query/selectors';
import { formatNumber, formatCompact, formatDay } from '../ui/primitives';

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const WEEKDAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

/** Étiquette d'axe : au pas mensuel, le numéro de jour n'a aucun sens. */
function formatAxisDate(value: string, granularity: Granularity): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  const month = MONTHS[date.getUTCMonth()] ?? '';
  if (granularity === 'month') return `${month} ${String(date.getUTCFullYear()).slice(2)}`;
  return `${date.getUTCDate()} ${month}`;
}

/**
 * Commits dans le temps, une série par contributeur nommé.
 *
 * Deux lectures, choisies par `stacked` :
 *  - empilé (défaut) : la composition d'un total — « combien de commits ce
 *    jour-là, et de qui » ;
 *  - courbes : « qui est plus actif que qui ». Empiler interdit cette lecture,
 *    la hauteur d'une bande dépendant de celles posées en dessous.
 */
export function CommitTimeline({
  days,
  series,
  colors,
  nameOf,
  palette,
  granularity = 'day',
  height = 300,
  stacked = true,
  stale,
}: {
  days: string[];
  series: Array<{ authorId: string; values: number[] }>;
  colors: ColorAssignment;
  nameOf: (id: string) => string;
  palette: Palette;
  granularity?: Granularity;
  height?: number;
  /** `false` : une courbe pleine par entité, toutes partant de zéro. */
  stacked?: boolean;
  stale?: boolean;
}) {
  const option = useMemo<EChartsOption>(() => {
    // L'ordre vient du sélecteur : « Autres » d'abord, donc au bas de la pile —
    // et, sans pile, tracé en premier donc derrière les séries nommées.
    const ordered = series;
    // Au-delà de 4 courbes, des noms posés au bout se marchent dessus : la
    // légende redevient seule porteuse de l'identité.
    const endLabels = !stacked && ordered.length <= 4;

    return {
      animation: false,
      grid: { top: 16, right: endLabels ? 112 : 16, bottom: 52, left: 52 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: palette.axis, width: 1 } },
        ...tooltipStyle(palette),
        order: 'valueDesc',
        valueFormatter: (value: unknown) => formatNumber(Number(value)),
      },
      legend:
        ordered.length >= 2
          ? {
              type: 'scroll',
              bottom: 0,
              itemWidth: 10,
              itemHeight: 10,
              itemGap: 14,
              icon: 'roundRect',
              // Les libellés restent en encre de texte : la pastille colorée
              // porte l'identité, pas le mot.
              textStyle: { color: palette.textSecondary, fontSize: 11 },
              inactiveColor: palette.textMuted,
            }
          : undefined,
      xAxis: {
        type: 'category',
        data: days,
        boundaryGap: false,
        ...axisStyle(palette),
        splitLine: { show: false },
        axisLabel: {
          color: palette.textMuted,
          fontSize: 11,
          hideOverlap: true,
          formatter: (value: string) => formatAxisDate(value, granularity),
        },
      },
      yAxis: {
        type: 'value',
        ...axisStyle(palette),
        axisLine: { show: false },
        axisLabel: { color: palette.textMuted, fontSize: 11, formatter: (v: number) => formatCompact(v) },
      },
      dataZoom: days.length > 120 ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 26 }] : undefined,
      series: ordered.map((entry) => ({
        type: 'line' as const,
        name: entry.authorId === OTHER_SERIES_ID ? OTHER_LABEL : nameOf(entry.authorId),
        stack: stacked ? 'commits' : undefined,
        // Empilé, le lissage est sans risque. Nue, une courbe expose le
        // dépassement de la spline sous zéro sur des séries en dents de scie :
        // des commits négatifs à l'écran.
        smooth: stacked ? 0.2 : false,
        showSymbol: false,
        symbolSize: 8,
        lineStyle: { width: 2 },
        ...(stacked ? { areaStyle: { opacity: 0.55 } } : {}),
        ...(endLabels
          ? {
              endLabel: {
                show: true,
                color: palette.textSecondary,
                fontSize: 11,
                width: 92,
                overflow: 'truncate' as const,
                formatter: (params: { seriesName?: string }) => params.seriesName ?? '',
              },
              // Deux personnes qui finissent au même niveau : on décale plutôt
              // que superposer deux noms illisibles.
              labelLayout: { moveOverlap: 'shiftY' as const },
            }
          : {}),
        emphasis: { focus: 'series' as const },
        itemStyle: {
          color: entry.authorId === OTHER_SERIES_ID ? palette.other : colors.colorOf(entry.authorId),
          // Un liseré à la couleur de la surface sépare les aires empilées :
          // c'est l'écart de 2 px demandé, pas une bordure décorative. Sans
          // pile il ne ferait que cerner les symboles.
          ...(stacked ? { borderColor: palette.surface, borderWidth: 2 } : {}),
        },
        data: entry.values,
      })),
    };
  }, [days, series, colors, nameOf, palette, granularity, stacked]);

  return <EChart option={option} height={height} stale={stale} aria-label="Commits dans le temps par contributeur" />;
}

/**
 * Le calendrier s'ancre en haut et sa hauteur de grille est fixe : la hauteur
 * du composant est donc une somme, pas une valeur devinée. La légende passe
 * SOUS la grille — au-dessus, elle recouvre les libellés de mois qu'ECharts
 * dessine 10 px hors du rectangle du calendrier.
 */
const CELL_HEIGHT = 14;
const WEEK_ROWS = 7;
const MONTH_BAND = 28; // marge d'ECharts (10 px) + une ligne de texte de 11 px
const LEGEND_GAP = 14;
const LEGEND_ITEM = 12;
const LEGEND_TOP = MONTH_BAND + WEEK_ROWS * CELL_HEIGHT + LEGEND_GAP;
const CALENDAR_HEIGHT = LEGEND_TOP + LEGEND_ITEM + 8;

/** Libellé d'un palier de la légende : « 1 », « 4 à 6 », « 7 et + ». */
function pieceLabel(from: number, next: number | undefined): string {
  if (next === undefined) return `${formatNumber(from)} et +`;
  if (next - from === 1) return formatNumber(from);
  return `${formatNumber(from)} à ${formatNumber(next - 1)}`;
}

/**
 * Calendrier d'activité type GitHub.
 * Encodage séquentiel : une seule teinte, clair → foncé, accompagnée d'une
 * légende d'échelle placée sous la grille.
 */
export function ActivityCalendar({
  points,
  palette,
  height = CALENDAR_HEIGHT,
  stale,
}: {
  points: DayPoint[];
  palette: Palette;
  height?: number;
  stale?: boolean;
}) {
  const option = useMemo<EChartsOption>(() => {
    if (points.length === 0) return { animation: false } satisfies EChartsOption;
    const max = points.reduce((best, point) => Math.max(best, point.commits), 0);
    const first = points[0]!.day;
    const last = points[points.length - 1]!.day;

    // Paliers explicites plutôt que le découpage automatique d'ECharts, qui est
    // linéaire : sur une période large, il rangeait les journées à 1-4 commits
    // dans le même seau que les journées vides, et les peignait du même gris.
    const breaks = sequentialBreaks(max);
    const ramp = sequentialRamp(breaks.length, palette);
    const pieces = [
      // Le zéro porte le gris, et c'est le seul à le porter. Borner par `lt: 1`
      // plutôt que par la valeur exacte rend la couverture totale : aucune
      // valeur ne peut retomber sur l'interpolation de secours d'ECharts.
      { lt: 1, label: '0', color: palette.grid },
      ...breaks.map((from, index) => ({
        gte: from,
        ...(breaks[index + 1] === undefined ? {} : { lt: breaks[index + 1] }),
        label: pieceLabel(from, breaks[index + 1]),
        color: ramp[index]!,
      })),
    ];

    return {
      animation: false,
      tooltip: {
        ...tooltipStyle(palette),
        formatter: (params: unknown) => {
          const value = (params as { value: [string, number] }).value;
          const commits = value[1];
          return `<strong>${formatDay(value[0])}</strong><br/>${
            commits === 0 ? 'aucun commit' : `${formatNumber(commits)} commit${commits > 1 ? 's' : ''}`
          }`;
        },
      },
      visualMap: {
        type: 'piecewise',
        orient: 'horizontal',
        top: LEGEND_TOP,
        right: 12,
        // Le défaut d'ECharts est 15 px, appliqués AVANT le positionnement :
        // c'est lui qui faisait retomber les pastilles sur les libellés de mois.
        padding: 0,
        itemWidth: LEGEND_ITEM,
        itemHeight: LEGEND_ITEM,
        itemGap: 3,
        pieces,
        // Les libellés chiffrés des paliers tripleraient la largeur de la
        // bande ; ils restent renseignés, les afficher tient en une ligne.
        showLabel: false,
        // L'échelle s'adapte à la période : annoncer le maximum réel vaut mieux
        // qu'un « + » muet. Période vide : rien à annoncer.
        text: [max > 0 ? formatNumber(max) : '', '0'],
        textStyle: { color: palette.textMuted, fontSize: 11 },
        // Les pastilles sont cliquables par défaut et masquent leur palier,
        // mais la sélection est effacée au changement de filtre suivant : une
        // interaction invisible qui disparaît toute seule ne vaut rien.
        selectedMode: false,
        // Rampe à une seule teinte : jamais d'arc-en-ciel pour une magnitude.
        // Sans ce repli, ECharts en fabrique un.
        inRange: { color: ramp },
      },
      calendar: {
        top: MONTH_BAND,
        left: 40,
        right: 12,
        // Ne jamais ajouter `bottom` ici : renseigner les deux bornes ferait
        // basculer la hauteur de cellule en « auto » et étirerait les 7 lignes
        // sur toute la carte.
        cellSize: ['auto', CELL_HEIGHT],
        range: [first, last],
        splitLine: { show: false },
        itemStyle: {
          color: palette.grid,
          borderWidth: 2,
          borderColor: palette.surface, // l'écart de 2 px, pas une bordure
        },
        yearLabel: { show: false },
        monthLabel: {
          color: palette.textMuted,
          fontSize: 11,
          nameMap: MONTHS,
        },
        dayLabel: {
          color: palette.textMuted,
          fontSize: 10,
          firstDay: 1,
          nameMap: WEEKDAYS,
        },
      },
      series: [
        {
          type: 'heatmap',
          coordinateSystem: 'calendar',
          data: points.map((point) => [point.day, point.commits] as [string, number]),
        },
      ],
    };
  }, [points, palette]);

  return <EChart option={option} height={height} stale={stale} aria-label="Calendrier d'activité" />;
}

/**
 * Classement horizontal. Une seule série ⇒ une seule couleur et aucune légende :
 * colorer chaque barre selon sa longueur double-encoderait une information déjà
 * portée par la barre.
 */
export function RankingBars({
  items,
  palette,
  colorOf,
  height = 320,
  valueLabel = 'commits',
  stale,
  onSelect,
}: {
  items: Array<{ id: string; label: string; value: number }>;
  palette: Palette;
  /** Optionnel : couleur par entité (classement de personnes). */
  colorOf?: (id: string) => string;
  height?: number;
  valueLabel?: string;
  stale?: boolean;
  onSelect?: (id: string) => void;
}) {
  const option = useMemo<EChartsOption>(() => {
    const ordered = [...items].reverse(); // ECharts empile de bas en haut
    const max = items.reduce((best, item) => Math.max(best, item.value), 0);

    return {
      animation: false,
      grid: { top: 8, right: 56, bottom: 8, left: 8, containLabel: true },
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(palette),
        formatter: (params: unknown) => {
          const p = params as { name: string; value: number };
          return `<strong>${p.name}</strong><br/>${formatNumber(p.value)} ${valueLabel}`;
        },
      },
      xAxis: { type: 'value', show: false, max: max * 1.08 },
      yAxis: {
        type: 'category',
        data: ordered.map((item) => item.label),
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: palette.textSecondary, fontSize: 12, width: 180, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 14,
          // Extrémité arrondie côté valeur, ancrée à la ligne de base.
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            color: (params: { dataIndex: number }) => {
              const item = ordered[params.dataIndex];
              return item && colorOf ? colorOf(item.id) : palette.series[0]!;
            },
          },
          // Étiquetage direct : la valeur est utile ici (peu de barres, lecture
          // immédiate), placée hors de la barre pour ne jamais être rognée.
          label: {
            show: true,
            position: 'right',
            distance: 8,
            color: palette.textSecondary,
            fontSize: 11,
            formatter: (params: { value?: unknown }) => formatCompact(Number(params.value ?? 0)),
          },
          data: ordered.map((item) => item.value),
        },
      ],
    };
  }, [items, palette, colorOf, valueLabel]);

  const handlers = useMemo(
    () =>
      onSelect
        ? {
            click: (params: unknown) => {
              const index = (params as { dataIndex: number }).dataIndex;
              const reversed = [...items].reverse();
              const item = reversed[index];
              if (item) onSelect(item.id);
            },
          }
        : undefined,
    [onSelect, items],
  );

  return (
    <EChart option={option} height={height} stale={stale} onEvent={handlers} aria-label={`Classement par ${valueLabel}`} />
  );
}

/** Treemap des projets par volume — magnitude, donc rampe séquentielle. */
export function ProjectTreemap({
  items,
  palette,
  height = 340,
  stale,
  onSelect,
}: {
  items: Array<{ id: string; label: string; value: number }>;
  palette: Palette;
  height?: number;
  stale?: boolean;
  onSelect?: (id: string) => void;
}) {
  const option = useMemo<EChartsOption>(() => {
    const max = items.reduce((best, item) => Math.max(best, item.value), 0);
    const total = items.reduce((sum, item) => sum + item.value, 0);
    // En dessous de ~1,5 % de la surface, l'étiquette serait tronquée à deux
    // caractères. L'infobulle prend le relais.
    const labelThreshold = total * 0.015;
    return {
      animation: false,
      tooltip: {
        ...tooltipStyle(palette),
        formatter: (params: unknown) => {
          const p = params as { name: string; value: number };
          return `<strong>${p.name}</strong><br/>${formatNumber(p.value)} commits`;
        },
      },
      series: [
        {
          type: 'treemap',
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          top: 4,
          bottom: 4,
          left: 4,
          right: 4,
          itemStyle: { borderColor: palette.surface, borderWidth: 2, gapWidth: 2 },
          // Une étiquette n'est rendue que si elle tient : sinon elle est rognée
          // et devient illisible. L'infobulle prend le relais.
          label: {
            show: true,
            color: '#ffffff',
            fontSize: 11,
            overflow: 'truncate',
            formatter: (params: { name?: string; value?: unknown }) => {
              const value = Number(params.value ?? 0);
              if (value < labelThreshold) return '';
              return `${params.name ?? ''}\n${formatCompact(value)}`;
            },
          },
          upperLabel: { show: false },
          data: items.map((item) => ({
            id: item.id,
            name: item.label,
            value: item.value,
            itemStyle: { color: sequentialColor(item.value, max, palette) },
          })),
        },
      ],
    };
  }, [items, palette]);

  const handlers = useMemo(
    () =>
      onSelect
        ? {
            click: (params: unknown) => {
              const id = (params as { data?: { id?: string } }).data?.id;
              if (typeof id === 'string' && id !== '') onSelect(id);
            },
          }
        : undefined,
    [onSelect],
  );

  return <EChart option={option} height={height} stale={stale} onEvent={handlers} aria-label="Répartition des commits par projet" />;
}

/**
 * Lignes ajoutées / supprimées.
 * Polarité ⇒ paire divergente (froid/chaud) autour d'un zéro neutre, sur UN seul
 * axe : les suppressions sont tracées en négatif plutôt que sur une 2ᵉ échelle.
 */
export function LinesDelta({
  points,
  palette,
  granularity = 'day',
  height = 240,
  stale,
}: {
  points: DayPoint[];
  palette: Palette;
  granularity?: Granularity;
  height?: number;
  stale?: boolean;
}) {
  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      grid: { top: 24, right: 16, bottom: 44, left: 56 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: palette.axis, width: 1 } },
        ...tooltipStyle(palette),
        formatter: (params: unknown) => {
          const rows = params as Array<{ axisValue: string; value: number; seriesName: string; color: string }>;
          const header = `<strong>${formatDay(rows[0]?.axisValue ?? '')}</strong>`;
          const body = rows
            .map(
              (row) =>
                `<div style="display:flex;gap:6px;align-items:center"><span style="width:8px;height:8px;border-radius:2px;background:${row.color}"></span>${row.seriesName} : ${formatNumber(Math.abs(row.value))}</div>`,
            )
            .join('');
          return `${header}${body}`;
        },
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 10,
        itemHeight: 10,
        icon: 'roundRect',
        textStyle: { color: palette.textSecondary, fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: points.map((point) => point.day),
        boundaryGap: true,
        ...axisStyle(palette),
        splitLine: { show: false },
        axisLabel: {
          color: palette.textMuted,
          fontSize: 11,
          hideOverlap: true,
          formatter: (value: string) => formatAxisDate(value, granularity),
        },
      },
      yAxis: {
        type: 'value',
        ...axisStyle(palette),
        axisLine: { show: false },
        axisLabel: {
          color: palette.textMuted,
          fontSize: 11,
          formatter: (value: number) => formatCompact(Math.abs(value)),
        },
      },
      series: [
        {
          type: 'bar',
          name: 'Lignes ajoutées',
          stack: 'lines',
          barMaxWidth: 12,
          itemStyle: { color: palette.divergingPositive, borderRadius: [4, 4, 0, 0] },
          data: points.map((point) => point.additions),
        },
        {
          type: 'bar',
          name: 'Lignes supprimées',
          stack: 'lines',
          barMaxWidth: 12,
          itemStyle: { color: palette.divergingNegative, borderRadius: [0, 0, 4, 4] },
          data: points.map((point) => -point.deletions),
        },
      ],
    }),
    [points, palette, granularity],
  );

  return <EChart option={option} height={height} stale={stale} aria-label="Lignes ajoutées et supprimées" />;
}

/** Rythme de travail : heures de la journée et jours de la semaine. */
export function RhythmChart({
  hours,
  weekdays,
  palette,
  height = 200,
}: {
  hours: number[];
  weekdays: number[];
  palette: Palette;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    const maxHour = hours.reduce((best, value) => Math.max(best, value), 0);
    const maxDay = weekdays.reduce((best, value) => Math.max(best, value), 0);
    return {
      animation: false,
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(palette),
        formatter: (params: unknown) => {
          const p = params as { name: string; value: number };
          return `${p.name} — ${formatNumber(p.value)} commits`;
        },
      },
      grid: [
        { top: 24, left: 44, right: 12, height: '38%' },
        { top: '64%', left: 44, right: 12, height: '26%' },
      ],
      xAxis: [
        {
          gridIndex: 0,
          type: 'category',
          data: Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')} h`),
          ...axisStyle(palette),
          splitLine: { show: false },
          axisLabel: {
            color: palette.textMuted,
            fontSize: 10,
            interval: 2,
            formatter: (value: string) => value.slice(0, 2),
          },
        },
        {
          gridIndex: 1,
          type: 'category',
          data: ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'],
          ...axisStyle(palette),
          splitLine: { show: false },
          axisLabel: { color: palette.textMuted, fontSize: 11 },
        },
      ],
      yAxis: [
        { gridIndex: 0, type: 'value', max: Math.max(1, maxHour), ...axisStyle(palette), axisLine: { show: false }, axisLabel: { show: false } },
        { gridIndex: 1, type: 'value', max: Math.max(1, maxDay), ...axisStyle(palette), axisLine: { show: false }, axisLabel: { show: false } },
      ],
      series: [
        {
          type: 'bar',
          xAxisIndex: 0,
          yAxisIndex: 0,
          barMaxWidth: 12,
          itemStyle: { color: palette.series[0]!, borderRadius: [4, 4, 0, 0] },
          data: hours,
        },
        {
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          barMaxWidth: 20,
          itemStyle: { color: palette.series[0]!, borderRadius: [4, 4, 0, 0] },
          // Lundi en premier : `weekdays` est indexé dimanche = 0.
          data: [1, 2, 3, 4, 5, 6, 0].map((index) => weekdays[index] ?? 0),
        },
      ],
    };
  }, [hours, weekdays, palette]);

  return <EChart option={option} height={height} aria-label="Rythme d'activité" />;
}

/** Radar de comparaison — chaque axe est normalisé à 100 sur le maximum du groupe. */
export function CompareRadar({
  indicators,
  entries,
  colors,
  palette,
  height = 340,
}: {
  indicators: Array<{ name: string; max: number }>;
  entries: Array<{ id: string; label: string; values: number[]; raw: number[] }>;
  colors: ColorAssignment;
  palette: Palette;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      tooltip: {
        ...tooltipStyle(palette),
        formatter: (params: unknown) => {
          const p = params as { name: string; dataIndex: number };
          const entry = entries[p.dataIndex];
          if (!entry) return '';
          const rows = indicators
            .map((indicator, i) => `${indicator.name} : ${formatNumber(entry.raw[i] ?? 0)}`)
            .join('<br/>');
          return `<strong>${entry.label}</strong><br/>${rows}`;
        },
      },
      legend: {
        bottom: 0,
        itemWidth: 10,
        itemHeight: 10,
        icon: 'roundRect',
        textStyle: { color: palette.textSecondary, fontSize: 11 },
      },
      radar: {
        indicator: indicators,
        center: ['50%', '46%'],
        radius: '64%',
        splitNumber: 4,
        axisName: { color: palette.textMuted, fontSize: 11 },
        splitLine: { lineStyle: { color: palette.grid } },
        splitArea: { show: false },
        axisLine: { lineStyle: { color: palette.grid } },
      },
      series: [
        {
          type: 'radar',
          symbolSize: 8,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.12 },
          emphasis: { focus: 'series' },
          data: entries.map((entry) => ({
            name: entry.label,
            value: entry.values,
            itemStyle: { color: colors.colorOf(entry.id), borderColor: palette.surface, borderWidth: 2 },
          })),
        },
      ],
    }),
    [indicators, entries, colors, palette],
  );

  return <EChart option={option} height={height} aria-label="Comparaison multi-critères" />;
}

/** Courbe de tendance minuscule, pour les cellules de tableau. */
export function Sparkline({ values, color, width = 88, height = 22 }: { values: number[]; color: string; width?: number; height?: number }) {
  if (values.length === 0) return <span className="text-[var(--text-muted)]">—</span>;
  const max = values.reduce((best, value) => Math.max(best, value), 0);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((value, index) => {
      const x = index * step;
      const y = height - (max > 0 ? (value / max) * (height - 2) : 0) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
