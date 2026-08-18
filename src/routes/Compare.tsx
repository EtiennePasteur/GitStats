/**
 * Comparateur de contributeurs.
 *
 * Le radar normalise chaque axe sur le maximum du groupe comparé — la forme
 * répond donc à « qui domine sur quelle dimension », pas à « qui a le plus gros
 * volume », que le tableau et les courbes donnent en valeurs brutes. Les deux
 * lectures sont présentées côte à côte pour éviter de sur-interpréter la surface
 * du polygone.
 */

import { useMemo, useState } from 'react';
import { useAnalytics, authorName } from '../query/useAnalytics';
import { byDayAndAuthor, pickGranularity, fillDays } from '../query/selectors';
import { toggleSelection, visibleSelection, isSelectionFull } from '../query/selection';
import { CommitTimeline, CompareRadar } from '../components/charts/charts';
import { DataTable, type Column } from '../components/DataTable';
import {
  Card,
  EmptyState,
  Avatar,
  Button,
  cx,
  formatNumber,
  formatCompact,
  formatDay,
} from '../components/ui/primitives';
import type { AuthorStats } from '../query/selectors';

const MAX_COMPARED = 5;

export function Compare() {
  const { authors, authorsById, authorColors, palette, buckets, labelOf, isEmpty } = useAnalytics();
  // `null` = l'utilisateur n'a pas encore touché à la sélection ; `[]` = il a
  // tout retiré. Confondre les deux rendait le premier clic inopérant.
  const [selected, setSelected] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');

  const defaultSelection = useMemo(
    () => authors.slice(0, 3).map((entry) => entry.authorId),
    [authors],
  );

  const known = useMemo(() => new Set(authors.map((entry) => entry.authorId)), [authors]);
  const effective = useMemo(
    () => visibleSelection(selected, defaultSelection, known),
    [selected, defaultSelection, known],
  );

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return authors
      .filter((entry) => {
        if (needle === '') return true;
        // Une personne sélectionnée reste toujours visible : la masquer par la
        // recherche la rendrait impossible à désélectionner.
        if (effective.includes(entry.authorId)) return true;
        const name = labelOf(entry.authorId).toLowerCase();
        return name.includes(needle) || entry.authorId.toLowerCase().includes(needle);
      })
      .slice(0, 60);
  }, [authors, labelOf, query, effective]);

  /**
   * L'ordre d'affichage suit le classement par commits, jamais l'ordre des
   * clics : le même groupe de personnes doit donner exactement le même
   * graphique, quel que soit l'ordre dans lequel on les a choisies.
   */
  const compared = useMemo(
    () => authors.filter((entry) => effective.includes(entry.authorId)),
    [effective, authors],
  );

  const comparedBuckets = useMemo(() => {
    const ids = new Set(effective);
    return buckets.filter((bucket) => ids.has(bucket.authorId));
  }, [buckets, effective]);

  /**
   * Le cadre temporel se calcule sur TOUT le périmètre, pas sur les seules
   * personnes comparées. Sinon changer de personne déplace les bornes de l'axe,
   * et un écart d'étalement suffisant fait basculer le pas de temps : deux
   * comparaisons successives ne se lisent plus l'une contre l'autre.
   */
  const frame = useMemo(() => {
    let from: string | null = null;
    let to: string | null = null;
    for (const bucket of buckets) {
      if (from === null || bucket.day < from) from = bucket.day;
      if (to === null || bucket.day > to) to = bucket.day;
    }
    return { from, to };
  }, [buckets]);

  const timeline = useMemo(() => {
    if (frame.from === null || frame.to === null) {
      return { days: [], series: [], granularity: 'day' as const };
    }
    return byDayAndAuthor(
      comparedBuckets,
      compared.map((entry) => entry.authorId),
      {
        from: frame.from,
        to: frame.to,
        granularity: pickGranularity(fillDays(frame.from, frame.to).length),
      },
    );
  }, [comparedBuckets, compared, frame]);

  const radar = useMemo(() => {
    if (compared.length === 0) return { indicators: [], entries: [] };
    const dimensions = [
      { name: 'Commits', get: (entry: AuthorStats) => entry.commits },
      { name: 'Lignes ajoutées', get: (entry: AuthorStats) => entry.additions },
      { name: 'Lignes supprimées', get: (entry: AuthorStats) => entry.deletions },
      { name: 'Dépôts touchés', get: (entry: AuthorStats) => entry.projectKeys.size },
      { name: 'Jours actifs', get: (entry: AuthorStats) => entry.activeDays },
    ];
    const maxima = dimensions.map((dimension) =>
      Math.max(1, ...compared.map((entry) => dimension.get(entry))),
    );
    return {
      indicators: dimensions.map((dimension) => ({ name: dimension.name, max: 100 })),
      entries: compared.map((entry) => ({
        id: entry.authorId,
        label: labelOf(entry.authorId),
        values: dimensions.map((dimension, i) => Math.round((dimension.get(entry) / maxima[i]!) * 100)),
        raw: dimensions.map((dimension) => dimension.get(entry)),
      })),
    };
  }, [compared, labelOf]);

  const toggle = (id: string) => {
    setSelected(toggleSelection(effective, defaultSelection, id, MAX_COMPARED));
  };

  if (isEmpty) {
    return <EmptyState title="Aucune donnée">Lancez une synchronisation d'abord.</EmptyState>;
  }

  const columns: Array<Column<AuthorStats>> = [
    {
      key: 'author',
      header: 'Contributeur',
      width: 'minmax(180px, 2fr)',
      render: (row) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={authorName(authorsById, row.authorId)} color={authorColors.colorOf(row.authorId)} />
          <span className="truncate text-[var(--text-primary)]">{labelOf(row.authorId)}</span>
        </span>
      ),
    },
    { key: 'commits', header: 'Commits', align: 'right', numeric: true, width: '100px', sortValue: (r) => r.commits, render: (r) => formatNumber(r.commits) },
    {
      key: 'additions',
      header: 'Lignes +',
      align: 'right',
      numeric: true,
      width: '100px',
      sortValue: (r) => r.additions,
      render: (r) => <span style={{ color: palette.divergingPositive }}>{formatCompact(r.additions)}</span>,
    },
    {
      key: 'deletions',
      header: 'Lignes −',
      align: 'right',
      numeric: true,
      width: '100px',
      sortValue: (r) => r.deletions,
      render: (r) => <span style={{ color: palette.divergingNegative }}>{formatCompact(r.deletions)}</span>,
    },
    { key: 'projects', header: 'Dépôts', align: 'right', numeric: true, width: '90px', sortValue: (r) => r.projectKeys.size, render: (r) => formatNumber(r.projectKeys.size) },
    { key: 'days', header: 'Jours actifs', align: 'right', numeric: true, width: '110px', sortValue: (r) => r.activeDays, render: (r) => formatNumber(r.activeDays) },
    {
      key: 'perDay',
      header: 'Commits / jour actif',
      align: 'right',
      numeric: true,
      width: '160px',
      sortValue: (r) => (r.activeDays > 0 ? r.commits / r.activeDays : 0),
      render: (r) => (r.activeDays > 0 ? (r.commits / r.activeDays).toFixed(1) : '—'),
    },
    {
      key: 'span',
      header: 'Période',
      align: 'right',
      width: '190px',
      sortValue: (r) => r.firstDay ?? '',
      render: (r) => (
        <span className="text-xs text-[var(--text-muted)]">
          {r.firstDay ? formatDay(r.firstDay) : '—'} → {r.lastDay ? formatDay(r.lastDay) : '—'}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <Card
        title="Choisir les personnes à comparer"
        subtitle={`${effective.length} sélectionnée(s), ${MAX_COMPARED} maximum`}
        actions={
          selected !== null ? (
            <Button variant="subtle" onClick={() => setSelected(null)}>
              Réinitialiser
            </Button>
          ) : undefined
        }
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Rechercher une personne…"
          className="mb-3 h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
        />
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {candidates.map((entry) => {
            const active = effective.includes(entry.authorId);
            const full = isSelectionFull(effective, defaultSelection, entry.authorId, MAX_COMPARED);
            return (
              <button
                key={entry.authorId}
                type="button"
                aria-pressed={active}
                disabled={full}
                // La puce tronque : sur deux homonymes, c'est justement l'indice
                // qui départage qui saute. Le survol le rend.
                title={labelOf(entry.authorId)}
                onClick={() => toggle(entry.authorId)}
                className={cx(
                  'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1 text-sm transition',
                  active
                    ? 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-primary)]'
                    : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                  full && 'cursor-not-allowed opacity-40',
                )}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-[3px]"
                  style={{ background: active ? authorColors.colorOf(entry.authorId) : 'var(--text-muted)' }}
                />
                <span className="max-w-[160px] truncate">{labelOf(entry.authorId)}</span>
                <span className="tnum text-xs text-[var(--text-muted)]">{formatCompact(entry.commits)}</span>
              </button>
            );
          })}
        </div>
        {selected === null && (
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Aucune sélection : les 3 premiers contributeurs du périmètre sont comparés par défaut.
          </p>
        )}
      </Card>

      {effective.length === 0 ? (
        <EmptyState title="Aucune personne sélectionnée">
          Choisissez au moins un contributeur ci-dessus, ou réinitialisez pour revenir aux 3
          premiers du périmètre.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
            <Card title="Commits dans le temps" subtitle="valeurs brutes, une courbe par personne">
              {/*
                Non empilé : c'est tout l'objet de l'onglet. Empilées, deux
                bandes ne se comparent pas — la hauteur de l'une dépend de
                celles posées en dessous.
              */}
              <CommitTimeline
                days={timeline.days}
                series={timeline.series}
                colors={authorColors}
                nameOf={labelOf}
                palette={palette}
                granularity={timeline.granularity}
                height={340}
                stacked={false}
              />
            </Card>

            <Card
              title="Profils comparés"
              subtitle="chaque axe est ramené à 100 sur le maximum du groupe"
            >
              <CompareRadar
                indicators={radar.indicators}
                entries={radar.entries}
                colors={authorColors}
                palette={palette}
              />
            </Card>
          </div>

          <Card title="Valeurs détaillées" bodyClassName="px-0 pb-0">
            <DataTable
              rows={compared}
              columns={columns}
              rowKey={(row) => row.authorId}
              defaultSort={{ key: 'commits', direction: 'desc' }}
              caption="Comparaison des contributeurs"
            />
          </Card>
        </>
      )}
    </div>
  );
}
