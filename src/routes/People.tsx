import { useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAnalytics, authorName } from '../query/useAnalytics';
import { useAppStore } from '../store/useAppStore';
import type { ProjectKey } from '../model/types';
import { byDay, byDayAndAuthor, pickGranularity, type AuthorStats } from '../query/selectors';
import { DataTable, type Column } from '../components/DataTable';
import {
  ActivityCalendar,
  CommitTimeline,
  RankingBars,
  RhythmChart,
  Sparkline,
} from '../components/charts/charts';
import {
  Card,
  StatTile,
  EmptyState,
  Avatar,
  SeriesDot,
  StatusBadge,
  formatNumber,
  formatCompact,
  formatDay,
} from '../components/ui/primitives';

export function People() {
  const navigate = useNavigate();
  const { authors, authorsById, authorColors, palette, buckets, labelOf, isEmpty } = useAnalytics();
  const [query, setQuery] = useState('');

  const sparklines = useMemo(() => {
    const byAuthorWeek = new Map<string, Map<string, number>>();
    for (const bucket of buckets) {
      let weeks = byAuthorWeek.get(bucket.authorId);
      if (weeks === undefined) {
        weeks = new Map();
        byAuthorWeek.set(bucket.authorId, weeks);
      }
      const week = bucket.day.slice(0, 8);
      weeks.set(week, (weeks.get(week) ?? 0) + bucket.commits);
    }
    const result = new Map<string, number[]>();
    for (const [authorId, weeks] of byAuthorWeek) {
      result.set(
        authorId,
        [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, value]) => value),
      );
    }
    return result;
  }, [buckets]);

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (needle === '') return authors;
    return authors.filter((row) => {
      if (labelOf(row.authorId).toLowerCase().includes(needle)) return true;
      // Le tableau affiche l'adresse sous le nom : la chercher doit fonctionner.
      // Toutes les adresses, pas seulement la principale — une identité fusionnée
      // en porte plusieurs, et c'est souvent la secondaire qu'on a sous les yeux.
      const author = authorsById.get(row.authorId);
      if (author === undefined) return false;
      return author.knownEmails.some((mail) => mail.toLowerCase().includes(needle));
    });
  }, [authors, authorsById, labelOf, needle]);

  if (isEmpty) {
    return <EmptyState title="Aucune donnée">Lancez une synchronisation d'abord.</EmptyState>;
  }

  const columns: Array<Column<AuthorStats>> = [
    {
      key: 'author',
      header: 'Contributeur',
      width: 'minmax(220px, 2.5fr)',
      sortValue: (row) => authorName(authorsById, row.authorId),
      render: (row) => {
        const author = authorsById.get(row.authorId);
        const color = authorColors.colorOf(row.authorId);
        return (
          <span className="flex min-w-0 items-center gap-2.5">
            <Avatar name={author?.displayName ?? row.authorId} color={color} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[var(--text-primary)]">{author?.displayName ?? row.authorId}</span>
              <span className="truncate text-xs text-[var(--text-muted)]">{author?.primaryEmail}</span>
            </span>
            {author?.isBot === true && <StatusBadge tone="neutral">bot</StatusBadge>}
          </span>
        );
      },
    },
    {
      key: 'trend',
      header: 'Tendance',
      width: '110px',
      render: (row) => (
        <Sparkline values={sparklines.get(row.authorId) ?? []} color={authorColors.colorOf(row.authorId)} />
      ),
    },
    {
      key: 'commits',
      header: 'Commits',
      align: 'right',
      numeric: true,
      width: '100px',
      sortValue: (row) => row.commits,
      render: (row) => formatNumber(row.commits),
    },
    {
      key: 'additions',
      header: 'Lignes +',
      align: 'right',
      numeric: true,
      width: '100px',
      sortValue: (row) => row.additions,
      render: (row) => <span style={{ color: palette.divergingPositive }}>{formatCompact(row.additions)}</span>,
    },
    {
      key: 'deletions',
      header: 'Lignes −',
      align: 'right',
      numeric: true,
      width: '100px',
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
      width: '130px',
      sortValue: (row) => row.lastDay ?? '',
      render: (row) => <span className="text-[var(--text-muted)]">{row.lastDay ? formatDay(row.lastDay) : '—'}</span>,
    },
  ];

  return (
    <Card
      // Le titre garde le total : un chiffre de référence qui changerait à chaque
      // frappe ne serait plus une référence. Le décompte filtré va en sous-titre.
      title={`${formatNumber(authors.length)} contributeurs`}
      subtitle={
        needle === ''
          ? 'Cliquez sur une ligne pour la fiche détaillée.'
          : `${formatNumber(filtered.length)} sur ${formatNumber(authors.length)} · Cliquez sur une ligne pour la fiche détaillée.`
      }
      actions={
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Rechercher une personne…"
          // Isolé dans l'en-tête, le champ n'a aucun texte voisin qui le décrive.
          aria-label="Rechercher une personne"
          className="h-8 w-56 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
        />
      }
      bodyClassName="px-0 pb-0"
    >
      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(row) => row.authorId}
        defaultSort={{ key: 'commits', direction: 'desc' }}
        onRowClick={(row) => navigate(`/personnes/${encodeURIComponent(row.authorId)}`)}
        maxHeight={640}
        caption="Statistiques par contributeur"
        emptyLabel={
          needle === ''
            ? 'Aucune donnée sur ce périmètre.'
            : `Aucun contributeur ne correspond à « ${needle} ».`
        }
      />
    </Card>
  );
}

export function PersonDetail() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const authorId = decodeURIComponent(params.id ?? '');
  const { authorsById, projectsById, authorColors, palette, buckets } = useAnalytics();
  const rhythms = useAppStore((state) => state.dataset.rhythms);

  const author = authorsById.get(authorId);
  const mine = useMemo(() => buckets.filter((bucket) => bucket.authorId === authorId), [buckets, authorId]);

  const stats = useMemo(() => {
    let commits = 0;
    let additions = 0;
    let deletions = 0;
    const projects = new Map<ProjectKey, number>();
    const days = new Set<string>();
    for (const bucket of mine) {
      commits += bucket.commits;
      additions += bucket.additions;
      deletions += bucket.deletions;
      days.add(bucket.day);
      projects.set(bucket.projectKey, (projects.get(bucket.projectKey) ?? 0) + bucket.commits);
    }
    return { commits, additions, deletions, projects, activeDays: days.size };
  }, [mine]);

  const dayPoints = useMemo(() => byDay(mine), [mine]);
    const timeline = useMemo(
    () => byDayAndAuthor(mine, [authorId], { granularity: pickGranularity(dayPoints.length) }),
    [mine, authorId, dayPoints.length],
  );
  const rhythm = rhythms.get(authorId);

  if (author === undefined) {
    return <EmptyState title="Contributeur introuvable">Cette personne n'existe pas dans les données locales.</EmptyState>;
  }

  const color = authorColors.colorOf(authorId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/personnes" className="text-xs text-[var(--series-1)] hover:underline">
            ← Tous les contributeurs
          </Link>
          <div className="mt-1.5 flex items-center gap-3">
            <Avatar name={author.displayName} size={40} color={color} />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold">{author.displayName}</h1>
              <p className="truncate text-xs text-[var(--text-muted)]">
                {author.knownEmails.join(' · ') || author.primaryEmail}
              </p>
            </div>
          </div>
        </div>
        {author.identityKeys.length > 1 && (
          <StatusBadge tone="accent">{author.identityKeys.length} identités fusionnées</StatusBadge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Commits" value={formatNumber(stats.commits)} />
        <StatTile label="Lignes ajoutées" value={formatCompact(stats.additions)} accent={palette.divergingPositive} />
        <StatTile label="Lignes supprimées" value={formatCompact(stats.deletions)} accent={palette.divergingNegative} />
        <StatTile label="Dépôts touchés" value={formatNumber(stats.projects.size)} />
        <StatTile
          label="Jours actifs"
          value={formatNumber(stats.activeDays)}
          hint={
            stats.activeDays > 0
              ? `${(stats.commits / stats.activeDays).toFixed(1)} commits par jour actif`
              : undefined
          }
        />
      </div>

      <Card title="Activité quotidienne">
        <ActivityCalendar points={dayPoints} palette={palette} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Commits dans le temps">
          <CommitTimeline
            days={timeline.days}
            series={timeline.series}
            colors={authorColors}
            nameOf={() => author.displayName}
            palette={palette}
            granularity={timeline.granularity}
          />
        </Card>

        <Card title="Répartition par dépôt">
          <RankingBars
            items={[...stats.projects.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 12)
              .map(([key, commits]) => ({
                id: key,
                label: projectsById.get(key)?.name ?? key,
                value: commits,
              }))}
            palette={palette}
            onSelect={(key) => navigate(`/projets/${key}`)}
            height={Math.max(180, Math.min(12, stats.projects.size) * 26)}
          />
        </Card>
      </div>

      {rhythm !== undefined && (
        <Card
          title="Rythme de travail"
          subtitle="heures et jours calculés dans le fuseau de l'auteur du commit"
        >
          <RhythmChart hours={rhythm.hours} weekdays={rhythm.weekdays} palette={palette} />
        </Card>
      )}

      {author.identityKeys.length > 1 && (
        <Card title="Identités rattachées" subtitle="modifiable dans les réglages">
          <ul className="space-y-1 text-sm">
            {author.identityKeys.map((key) => (
              <li key={key} className="flex items-center gap-2 text-[var(--text-secondary)]">
                <SeriesDot color={color} />
                <code className="text-xs">{key}</code>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
