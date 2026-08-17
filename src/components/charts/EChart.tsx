/**
 * Enveloppe ECharts minimale.
 *
 * Deux comportements volontaires :
 *  - `notMerge: false` pour que la mise à jour d'une option conserve l'état
 *    d'interaction (survol, zoom) au lieu de tout reconstruire ;
 *  - au refetch, on garde le rendu précédent en opacité réduite plutôt que de
 *    réafficher un squelette : un squelette qui clignote à chaque filtre fait
 *    sauter la mise en page et donne une impression de lenteur.
 */

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, HeatmapChart, TreemapChart, RadarChart, CustomChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  VisualMapComponent,
  CalendarComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { cx } from '../ui/primitives';

echarts.use([
  BarChart,
  LineChart,
  HeatmapChart,
  TreemapChart,
  RadarChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  VisualMapComponent,
  CalendarComponent,
  CanvasRenderer,
]);

export interface EChartProps {
  option: EChartsOption;
  height?: number | string;
  className?: string;
  /** Rendu conservé en opacité réduite pendant un rafraîchissement. */
  stale?: boolean;
  onEvent?: Record<string, (params: unknown) => void>;
  'aria-label'?: string;
}

export function EChart({
  option,
  height = 280,
  className,
  stale = false,
  onEvent,
  'aria-label': ariaLabel,
}: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const handlersRef = useRef(onEvent);
  handlersRef.current = onEvent;

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;

    const chart = echarts.init(element, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    // Le ResizeObserver peut se déclencher après le démontage (il est notifié de
    // façon asynchrone) : sans ce garde, ECharts avertit qu'on manipule une
    // instance déjà libérée.
    const observer = new ResizeObserver(() => {
      if (!chart.isDisposed()) chart.resize();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null || chart.isDisposed()) return;
    // `lazyUpdate` différerait le rendu à la frame suivante : si le composant
    // est démonté entre-temps (navigation, StrictMode), ECharts travaille sur
    // une instance libérée. Le gain de perf ne vaut pas ce risque ici.
    chart.setOption(option, { notMerge: false, lazyUpdate: false });
  }, [option]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null || chart.isDisposed() || onEvent === undefined) return;
    const names = Object.keys(onEvent);
    for (const name of names) {
      chart.off(name);
      chart.on(name, (params: unknown) => handlersRef.current?.[name]?.(params));
    }
    return () => {
      // Les nettoyages s'exécutent dans l'ordre de déclaration des effets :
      // celui qui libère l'instance passe AVANT celui-ci. Détacher un
      // gestionnaire sur une instance déjà libérée déclenche un avertissement.
      if (chart.isDisposed()) return;
      for (const name of names) chart.off(name);
    };
  }, [onEvent]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel}
      className={cx('w-full transition-opacity duration-200', stale && 'opacity-60', className)}
      style={{ height }}
    />
  );
}

/** Chrome commun : grille et axes en filets pleins, discrets, jamais pointillés. */
export function axisStyle(palette: { grid: string; axis: string; textMuted: string }) {
  return {
    axisLine: { show: true, lineStyle: { color: palette.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: palette.textMuted, fontSize: 11 },
    splitLine: { show: true, lineStyle: { color: palette.grid, width: 1, type: 'solid' as const } },
  };
}

export function tooltipStyle(palette: { surfaceRaised: string; textPrimary: string; axis: string }) {
  return {
    backgroundColor: palette.surfaceRaised,
    borderColor: palette.axis,
    borderWidth: 1,
    textStyle: { color: palette.textPrimary, fontSize: 12 },
    extraCssText: 'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.32);',
  };
}
