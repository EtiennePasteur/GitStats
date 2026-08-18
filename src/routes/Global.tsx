import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { useAnalytics } from '../query/useAnalytics';
import { byDay, byDayAndAuthor, aggregateByGranularity, pickGranularity } from '../query/selectors';
import {
  ActivityCalendar,
  CommitTimeline,
  RankingBars,
  ProjectTreemap,
  LinesDelta,
} from '../components/charts/charts';
import { DataTable, type Column } from '../components/DataTable';
import {
  Card,
  StatTile,
  Button,
  EmptyState,
  SeriesDot,
  formatNumber,
  formatCompact,
  formatDay,
} from '../components/ui/primitives';
import type { AuthorStats, Granularity } from '../query/selectors';

const GRANULARITY_LABEL: Record<Granularity, string> = {
  day: 'par jour',
  week: 'par semaine',
  month: 'par mois',
};

export function Global() {
  const navigate = useNavigate();
  const analytics = useAnalytics();
  const isSyncing = useAppStore((state) => state.isSyncing);
  const startSync = useAppStore((state) => state.startSync);
  const overviewCount = useAppStore((state) => state.dataset.overviews.size);
  const [showTable, setShowTable] = useState(false);

  const { buckets, totals, authors, projects, palette, authorColors, projectsById, range, labelOf } =
    analytics;

  // Les axes suivent `range` (la période choisie), jamais l'étendue totale des
  // données : sinon changer de préréglage ne repositionne rien à l'écran.
  //
  // Le calendrier reste TOUJOURS journalier : c'est tout son intérêt. Seules les
  // courbes sont regroupées quand la période s'étale.
  const dayPoints = useMemo(
    () => byDay(buckets, range.from ?? undefined, range.to ?? undefined),
    [buckets, range],
  );
  const granularity = useMemo(() => pickGranularity(dayPoints.length), [dayPoints.length]);
  const trendPoints = useMemo(
    () => aggregateByGranularity(dayPoints, granularity, { trimPartialEdges: true }),
    [dayPoints, granularity],
  );

  // Mêmes bornes que le calendrier et la courbe de volume : trois cartes de la
  // même page qui n'afficheraient pas la même fenêtre se compareraient à tort.
  const timeline = useMemo(
    () =>
      byDayAndAuthor(buckets, authorColors.named.slice(0, 8), {
        from: range.from ?? undefined,
        to: range.to ?? undefined,
        granularity,
      }),
    [buckets, authorColors, range, granularity],
  );

  const topAuthors = useMemo(
    () =>
      authors.slice(0, 15).map((entry) => ({
        id: entry.authorId,
        label: labelOf(entry.authorId),
        value: entry.commits,
      })),
    [authors, labelOf],
  );

  const treemapItems = useMemo(
    () =>
      projects.slice(0, 30).map((entry) => ({
        id: entry.projectKey,
        label: projectsById.get(entry.projectKey)?.name ?? entry.projectKey,
        value: entry.commits,
      })),
    [projects, projectsById],
  );

  if (analytics.isEmpty) {
    return (
      <EmptyState title="Aucune donnée pour le moment">
        Lancez une synchronisation pour récupérer l'activité de vos dépôts GitLab.
        <div className="mt-4">
          <Button variant="primary" onClick={() => void startSync()} disabled={isSyncing}>
            {isSyncing ? 'Synchronisation en cours…' : 'Synchroniser'}
          </Button>
        </div>
      </EmptyState>
    );
  }

  const columns: Array<Column<AuthorStats>> = [
    {
      key: 'author',
      header: 'Contributeur',
      width: 'minmax(200px, 2fr)',
      sortValue: (row) => labelOf(row.authorId),
      render: (row) => (
        <span className="flex items-center gap-2">
          <SeriesDot color={authorColors.colorOf(row.authorId)} />
          <span className="truncate text-[var(--text-primary)]">{labelOf(row.authorId)}</span>
        </span>
      ),
    },
    {
      key: 'commits',
      header: 'Commits',
      align: 'right',
      numeric: true,
      width: '110px',
      sortValue: (row) => row.commits,
      render: (row) => formatNumber(row.commits),
    },
    {
      key: 'additions',
      header: 'Lignes +',
      align: 'right',
      numeric: true,
      width: '110px',
      sortValue: (row) => row.additions,
      render: (row) => <span style={{ color: palette.divergingPositive }}>{formatCompact(row.additions)}</span>,
    },
    {
      key: 'deletions',
      header: 'Lignes −',
      align: 'right',
      numeric: true,
      width: '110px',
      sortValue: (row) => row.deletions,
      render: (row) => <span style={{ color: palette.divergingNegative }}>{formatCompact(row.deletions)}</span>,
    },
    {
      key: 'projects',
      header: 'Dépôts',
      align: 'right',
      numeric: true,
      width: '90px',
      sortValue: (row) => row.projectKeys.size,
      render: (row) => formatNumber(row.projectKeys.size),
    },
    {
      key: 'days',
      header: 'Jours actifs',
      align: 'right',
      numeric: true,
      width: '110px',
      sortValue: (row) => row.activeDays,
      render: (row) => formatNumber(row.activeDays),
    },
    {
      key: 'last',
      header: 'Dernier commit',
      align: 'right',
      width: '140px',
      sortValue: (row) => row.lastDay ?? '',
      render: (row) => (
        <span className="text-[var(--text-muted)]">{row.lastDay ? formatDay(row.lastDay) : '—'}</span>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Commits" value={formatNumber(totals.commits)} hint={`sur ${formatNumber(totals.activeDays)} jours actifs`} />
        <StatTile
          label="Lignes ajoutées"
          value={formatCompact(totals.additions)}
          accent={palette.divergingPositive}
          hint="hors commits de merge"
        />
        <StatTile
          label="Lignes supprimées"
          value={formatCompact(totals.deletions)}
          accent={palette.divergingNegative}
          hint="hors commits de merge"
        />
        <StatTile label="Contributeurs" value={formatNumber(totals.activeAuthors)} />
        <StatTile
          label="Dépôts actifs"
          value={formatNumber(totals.activeProjects)}
          hint={`sur ${formatNumber(projectsById.size)} connus`}
        />
      </div>

      {isSyncing && (
        <p className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
          Synchronisation en cours — les graphiques se remplissent au fur et à mesure.
        </p>
      )}

      {overviewCount > 0 && totals.commits === 0 && (
        <p className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
          Seul l'aperçu global est disponible pour l'instant (chiffres cumulés depuis la création des
          dépôts, sans dimension temporelle). L'historique daté arrive avec la seconde vague.
        </p>
      )}

      <Card
        title="Activité quotidienne"
        subtitle={
          range.from !== null && range.to !== null
            ? `du ${formatDay(range.from)} au ${formatDay(range.to)}`
            : undefined
        }
      >
        <ActivityCalendar points={dayPoints} palette={palette} stale={isSyncing} />
      </Card>

      <Card
        title="Commits dans le temps"
        subtitle={`${GRANULARITY_LABEL[timeline.granularity]}${
          authorColors.others.length > 0
            ? ` · 8 principaux contributeurs détaillés, ${formatNumber(authorColors.others.length)} autres regroupés dans « Autres »`
            : ' · par contributeur'
        }`}
      >
        <CommitTimeline
          days={timeline.days}
          series={timeline.series}
          colors={authorColors}
          nameOf={labelOf}
          palette={palette}
          granularity={timeline.granularity}
          stale={isSyncing}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Volume de code"
          subtitle={`${GRANULARITY_LABEL[granularity]} · commits de merge exclus`}
        >
          <LinesDelta points={trendPoints} palette={palette} granularity={granularity} stale={isSyncing} />
        </Card>

        <Card title="Répartition par dépôt" subtitle="30 dépôts les plus actifs">
          <ProjectTreemap
            items={treemapItems}
            palette={palette}
            stale={isSyncing}
            onSelect={(key) => navigate(`/projets/${key}`)}
          />
        </Card>
      </div>

      <Card
        title="Classement des contributeurs"
        subtitle={`${formatNumber(authors.length)} personnes sur ce périmètre`}
        actions={
          <Button variant="subtle" onClick={() => setShowTable((value) => !value)}>
            {showTable ? 'Voir le graphique' : 'Voir le tableau'}
          </Button>
        }
        bodyClassName={showTable ? 'px-0 pb-0' : undefined}
      >
        {showTable ? (
          <DataTable
            rows={authors}
            columns={columns}
            rowKey={(row) => row.authorId}
            defaultSort={{ key: 'commits', direction: 'desc' }}
            onRowClick={(row) => navigate(`/personnes/${encodeURIComponent(row.authorId)}`)}
            caption="Statistiques par contributeur"
          />
        ) : (
          <RankingBars
            items={topAuthors}
            palette={palette}
            colorOf={(id) => authorColors.colorOf(id)}
            stale={isSyncing}
            onSelect={(id) => navigate(`/personnes/${encodeURIComponent(id)}`)}
            height={Math.max(200, topAuthors.length * 26)}
          />
        )}
      </Card>

    </div>
  );
}
