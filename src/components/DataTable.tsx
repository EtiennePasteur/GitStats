/**
 * Tableau triable, virtualisé au-delà d'un certain volume.
 *
 * Il joue aussi le rôle de « vue tableau » : chaque graphique doit avoir un
 * équivalent lisible sans percevoir les couleurs, et où toute valeur est
 * atteignable sans survol (une infobulle ne doit jamais être le seul accès
 * à une donnée).
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cx } from './ui/primitives';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Valeur de tri. Absente ⇒ colonne non triable. */
  sortValue?: (row: T) => number | string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
  /** Chiffres alignés verticalement ⇒ chasse fixe. */
  numeric?: boolean;
}

export type SortDirection = 'asc' | 'desc';

const VIRTUALIZE_THRESHOLD = 80;
const ROW_HEIGHT = 44;

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  defaultSort,
  onRowClick,
  maxHeight = 560,
  emptyLabel = 'Aucune donnée sur ce périmètre.',
  caption,
}: {
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  defaultSort?: { key: string; direction: SortDirection };
  onRowClick?: (row: T) => void;
  maxHeight?: number;
  emptyLabel?: string;
  caption?: string;
}) {
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (column?.sortValue === undefined) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    const getValue = column.sortValue;
    return [...rows].sort((a, b) => {
      const va = getValue(a);
      const vb = getValue(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * factor;
      return String(va).localeCompare(String(vb), 'fr') * factor;
    });
  }, [rows, columns, sort]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = sorted.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? sorted.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const toggleSort = (key: string) => {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'desc' };
      return { key, direction: current.direction === 'desc' ? 'asc' : 'desc' };
    });
  };

  const gridTemplate = columns.map((column) => column.width ?? '1fr').join(' ');

  const renderRow = (row: T, style?: React.CSSProperties) => (
    <div
      key={rowKey(row)}
      role="row"
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      onKeyDown={
        onRowClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onRowClick(row);
              }
            }
          : undefined
      }
      tabIndex={onRowClick ? 0 : undefined}
      className={cx(
        'grid items-center gap-3 border-b border-[var(--border)] px-3 text-sm',
        onRowClick &&
          'cursor-pointer hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--series-1)]',
      )}
      style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT, ...style }}
    >
      {columns.map((column) => (
        <div
          key={column.key}
          role="cell"
          className={cx(
            'min-w-0 truncate',
            column.align === 'right' && 'text-right',
            column.numeric === true && 'tnum',
          )}
        >
          {column.render(row)}
        </div>
      ))}
    </div>
  );

  if (sorted.length === 0) {
    return <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">{emptyLabel}</p>;
  }

  return (
    <div role="table" aria-label={caption} className="w-full">
      <div
        role="row"
        className="sticky top-0 z-10 grid items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-1)] px-3 py-2"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {columns.map((column) => {
          const sortable = column.sortValue !== undefined;
          const active = sort?.key === column.key;
          return (
            <button
              key={column.key}
              type="button"
              role="columnheader"
              aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
              disabled={!sortable}
              onClick={sortable ? () => toggleSort(column.key) : undefined}
              className={cx(
                'flex items-center gap-1 text-xs font-medium tracking-wide uppercase',
                column.align === 'right' ? 'justify-end' : 'justify-start',
                sortable ? 'cursor-pointer hover:text-[var(--text-primary)]' : 'cursor-default',
                active ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]',
              )}
            >
              <span className="truncate">{column.header}</span>
              {sortable && (
                <span aria-hidden className="text-[10px] opacity-70">
                  {active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight }}>
        {shouldVirtualize ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = sorted[item.index];
              if (row === undefined) return null;
              return renderRow(row, {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
              });
            })}
          </div>
        ) : (
          sorted.map((row) => renderRow(row))
        )}
      </div>
    </div>
  );
}
