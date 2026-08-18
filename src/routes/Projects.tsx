import { useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAnalytics } from '../query/useAnalytics';
import { useAppStore } from '../store/useAppStore';
import { useFilterStore } from '../store/useFilterStore';
import { byDay, byDayAndAuthor, pickGranularity, type ProjectStats } from '../query/selectors';
import { DataTable, type Column } from '../components/DataTable';
import { CommitTimeline, ActivityCalendar, RankingBars, Sparkline } from '../components/charts/charts';
import {
  Button,
  Card,
  StatTile,
  EmptyState,
  StatusBadge,
  InstanceBadge,
  SeriesDot,
  cx,
  formatNumber,
  formatCompact,
  formatDay,
  formatRelative,
  type StatusTone,
} from '../components/ui/primitives';
import type { ProjectSyncState, ProjectKey } from '../model/types';

const STATE_LABEL: Record<ProjectSyncState, string> = {
  pending: 'jamais synchronisé',
  overview: 'aperçu seul',
  commits: 'en cours',
  done: 'à jour',
  skipped: 'à jour',
  empty: 'dépôt vide',
  error: 'erreur',
};

const STATE_TONE: Record<ProjectSyncState, StatusTone> = {
  pending: 'neutral',
  overview: 'warning',
  commits: 'accent',
  done: 'good',
  skipped: 'good',
  empty: 'neutral',
  error: 'critical',
};

export function Projects() {
  const navigate = useNavigate();
  const { projects, projectsById, palette, buckets, isEmpty } = useAnalytics();
  const instances = useAppStore((state) => state.instances);
  const setProjectMuted = useAppStore((state) => state.setProjectMuted);
  const dataVersion = useAppStore((state) => state.dataVersion);
  const excludeMuted = useFilterStore((state) => state.excludeMuted);
  // Recherche locale au tableau : elle n'affiche ou masque que des lignes. Le
  // champ du bandeau, lui, restreint le périmètre de toute l'application — d'où
  // les deux libellés distincts, « Rechercher » ici et « Filtrer » là-haut.
  const [query, setQuery] = useState('');
  /** `null` sur une instance unique : la pastille n'apporterait rien. */
  const instanceLabel = (id: string | undefined): string | null =>
    instances.length > 1 ? (instances.find((entry) => entry.id === id)?.label ?? id ?? null) : null;

  /** Une mini-courbe par dépôt, calculée une seule fois pour toute la table. */
  const sparklines = useMemo(() => {
    const byProjectWeek = new Map<ProjectKey, Map<string, number>>();
    for (const bucket of buckets) {
      let weeks = byProjectWeek.get(bucket.projectKey);
      if (weeks === undefined) {
        weeks = new Map();
        byProjectWeek.set(bucket.projectKey, weeks);
      }
      // Regroupement hebdomadaire : une courbe journalière sur 88 px n'est
      // qu'un peigne illisible.
      const week = bucket.day.slice(0, 8);
      weeks.set(week, (weeks.get(week) ?? 0) + bucket.commits);
    }
    const result = new Map<ProjectKey, number[]>();
    for (const [key, weeks] of byProjectWeek) {
      result.set(
        key,
        [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, value]) => value),
      );
    }
    return result;
  }, [buckets]);

  /**
   * Dépôts retirés des statistiques. Comptés sur le Dataset complet et non sur les
   * lignes : masqués, ils n'ont justement plus de ligne, et leur absence doit être
   * annoncée plutôt que silencieuse.
   */
  const mutedCount = useMemo(() => {
    let count = 0;
    for (const project of projectsById.values()) {
      if (project.muted === true && project.excluded !== true) count += 1;
    }
    return count;
    // `projectsById` est le Dataset partagé, muté en place : sa référence ne
    // change jamais. Sans `dataVersion`, le compteur resterait figé jusqu'au
    // prochain rechargement de l'onglet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsById, dataVersion]);

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (needle === '') return projects;
    return projects.filter((row) => {
      const project = projectsById.get(row.projectKey);
      if (project === undefined) return false;
      // Deux champs, parce que deux écritures cohabitent : le nom lisible affiché
      // dans la colonne et le slug que l'on tape de mémoire. Chercher l'un ne
      // trouve pas l'autre.
      return (
        project.nameWithNamespace.toLowerCase().includes(needle) ||
        project.pathWithNamespace.toLowerCase().includes(needle)
      );
    });
  }, [projects, projectsById, needle]);

  if (isEmpty) {
    return <EmptyState title="Aucune donnée">Lancez une synchronisation d'abord.</EmptyState>;
  }

  const columns: Array<Column<ProjectStats>> = [
    {
      key: 'project',
      header: 'Dépôt',
      width: 'minmax(240px, 2.5fr)',
      sortValue: (row) => projectsById.get(row.projectKey)?.pathWithNamespace ?? '',
      render: (row) => {
        const project = projectsById.get(row.projectKey);
        return (
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5">
              <span
                className={cx(
                  'truncate',
                  // Même idiome que la carte des doublons : barré + encre atténuée.
                  project?.muted === true
                    ? 'text-[var(--text-muted)] line-through'
                    : 'text-[var(--text-primary)]',
                )}
              >
                {project?.name ?? row.projectKey}
              </span>
              <InstanceBadge label={instanceLabel(project?.instanceId)} />
            </span>
            <span className="truncate text-xs text-[var(--text-muted)]">{project?.namespaceFullPath}</span>
          </span>
        );
      },
    },
    {
      key: 'trend',
      header: 'Tendance',
      width: '110px',
      render: (row) => <Sparkline values={sparklines.get(row.projectKey) ?? []} color={palette.series[0]!} />,
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
      key: 'authors',
      header: 'Contributeurs',
      align: 'right',
      numeric: true,
      width: '120px',
      sortValue: (row) => row.authorIds.size,
      render: (row) => formatNumber(row.authorIds.size),
    },
    {
      key: 'last',
      header: 'Dernier commit',
      align: 'right',
      width: '130px',
      sortValue: (row) => row.lastDay ?? '',
      render: (row) => <span className="text-[var(--text-muted)]">{row.lastDay ? formatDay(row.lastDay) : '—'}</span>,
    },
    {
      key: 'state',
      header: 'État',
      align: 'right',
      width: '150px',
      sortValue: (row) => projectsById.get(row.projectKey)?.sync.state ?? '',
      render: (row) => {
        const state = projectsById.get(row.projectKey)?.sync.state ?? 'pending';
        return <StatusBadge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</StatusBadge>;
      },
    },
    {
      key: 'muted',
      header: 'Statistiques',
      align: 'right',
      width: '130px',
      render: (row) => {
        const muted = projectsById.get(row.projectKey)?.muted === true;
        return (
          // Rendu en lien plutôt qu'en bouton plein : répété sur des centaines de
          // lignes, un bloc coloré prend le pas sur les chiffres qu'on vient lire.
          <button
            type="button"
            title={
              muted
                ? 'Recompter ce dépôt dans les statistiques'
                : 'Retirer ce dépôt des statistiques, sans arrêter sa synchronisation'
            }
            // La ligne entière navigue vers la fiche, au clic comme à la touche
            // Entrée : sans ces coupures, agir sur le bouton changerait de page
            // dans la foulée.
            onClick={(event) => {
              event.stopPropagation();
              void setProjectMuted(row.projectKey, !muted);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className={cx(
              'cursor-pointer rounded text-xs underline-offset-2 transition hover:underline',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]',
              muted
                ? 'text-[var(--series-1)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            {muted ? 'Réintégrer' : 'Ignorer'}
          </button>
        );
      },
    },
  ];

  const subtitle = [
    needle === '' ? null : `${formatNumber(filtered.length)} sur ${formatNumber(projects.length)}`,
    excludeMuted && mutedCount > 0
      ? `${formatNumber(mutedCount)} ignoré${mutedCount > 1 ? 's' : ''}, masqué${mutedCount > 1 ? 's' : ''}`
      : null,
    'Cliquez sur une ligne pour le détail.',
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <Card
      // Le titre garde le total du périmètre : un chiffre de référence qui
      // changerait à chaque frappe ne serait plus une référence.
      title={`${formatNumber(projects.length)} dépôts actifs`}
      subtitle={subtitle}
      actions={
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Rechercher un dépôt…"
          // Isolé dans l'en-tête, le champ n'a aucun texte voisin qui le décrive.
          aria-label="Rechercher un dépôt"
          className="h-8 w-56 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
        />
      }
      bodyClassName="px-0 pb-0"
    >
      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(row) => row.projectKey}
        defaultSort={{ key: 'commits', direction: 'desc' }}
        onRowClick={(row) => navigate(`/projets/${row.projectKey}`)}
        maxHeight={640}
        caption="Statistiques par dépôt"
        emptyLabel={
          needle === ''
            ? 'Aucune donnée sur ce périmètre.'
            : `Aucun dépôt ne correspond à « ${needle} ».`
        }
      />
    </Card>
  );
}

export function ProjectDetail() {
  const params = useParams<{ key: string }>();
  const navigate = useNavigate();
  const projectKeyParam = params.key ?? '';
  // `includeMuted` : cette vue ne parle que d'UN dépôt. Aucun total agrégé ne peut
  // être gonflé, alors qu'une fiche vide serait incompréhensible.
  const analytics = useAnalytics({ includeMuted: true });
  const { projectsById, authorColors, palette, buckets, labelOf } = analytics;
  const dataset = useAnalyticsDataset();
  const instances = useAppStore((state) => state.instances);
  const setProjectMuted = useAppStore((state) => state.setProjectMuted);

  const project = projectsById.get(projectKeyParam);
  const projectBuckets = useMemo(
    () => buckets.filter((bucket) => bucket.projectKey === projectKeyParam),
    [buckets, projectKeyParam],
  );

  const dayPoints = useMemo(() => byDay(projectBuckets), [projectBuckets]);
  const stats = useMemo(() => {
    let commits = 0;
    let additions = 0;
    let deletions = 0;
    const authors = new Map<string, number>();
    for (const bucket of projectBuckets) {
      commits += bucket.commits;
      additions += bucket.additions;
      deletions += bucket.deletions;
      authors.set(bucket.authorId, (authors.get(bucket.authorId) ?? 0) + bucket.commits);
    }
    return { commits, additions, deletions, authors };
  }, [projectBuckets]);

  const rankedAuthorIds = useMemo(
    () => [...stats.authors.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
    [stats],
  );

  const timeline = useMemo(
    () => byDayAndAuthor(projectBuckets, rankedAuthorIds.slice(0, 8), {
      granularity: pickGranularity(dayPoints.length),
    }),
    [projectBuckets, rankedAuthorIds, dayPoints.length],
  );

  const recent = useMemo(
    () =>
      [...dataset.recentCommits.values()]
        .filter((commit) => commit.projectKey === projectKeyParam)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 50),
    [dataset, projectKeyParam],
  );

  if (project === undefined) {
    return <EmptyState title="Dépôt introuvable">Ce dépôt n'existe pas dans les données locales.</EmptyState>;
  }

  const detailInstanceLabel =
    instances.length > 1
      ? (instances.find((entry) => entry.id === project.instanceId)?.label ?? project.instanceId)
      : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/projets" className="text-xs text-[var(--series-1)] hover:underline">
            ← Tous les dépôts
          </Link>
          <h1 className="mt-1 flex items-center gap-2 truncate text-xl font-semibold">
            {project.nameWithNamespace}
            <InstanceBadge label={detailInstanceLabel} />
          </h1>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            branche <code className="rounded bg-[var(--surface-2)] px-1">{project.defaultBranch ?? '—'}</code>
            {' · '}dernière activité {formatRelative(project.lastActivityAt)}
            {' · '}
            <a href={project.webUrl} target="_blank" rel="noreferrer noopener" className="text-[var(--series-1)] hover:underline">
              ouvrir dans GitLab
            </a>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {project.muted === true && (
            <>
              <StatusBadge tone="neutral">Ignoré</StatusBadge>
              <Button
                variant="primary"
                title="Recompter ce dépôt dans les statistiques"
                onClick={() => void setProjectMuted(project.key, false)}
              >
                Réintégrer
              </Button>
            </>
          )}
          <StatusBadge tone={STATE_TONE[project.sync.state]}>{STATE_LABEL[project.sync.state]}</StatusBadge>
        </div>
      </div>

      {project.muted === true && (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-secondary)]">
          Ce dépôt est retiré des statistiques globales. Les chiffres ci-dessous sont bien les
          siens : la synchronisation, elle, n'a jamais été interrompue.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Commits" value={formatNumber(stats.commits)} />
        <StatTile label="Lignes ajoutées" value={formatCompact(stats.additions)} accent={palette.divergingPositive} />
        <StatTile label="Lignes supprimées" value={formatCompact(stats.deletions)} accent={palette.divergingNegative} />
        <StatTile label="Contributeurs" value={formatNumber(stats.authors.size)} />
      </div>

      <Card title="Activité quotidienne">
        <ActivityCalendar points={dayPoints} palette={palette} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Commits dans le temps" subtitle="par contributeur">
          <CommitTimeline
            days={timeline.days}
            series={timeline.series}
            colors={authorColors}
            nameOf={labelOf}
            palette={palette}
            granularity={timeline.granularity}
          />
        </Card>

        <Card title="Contributeurs du dépôt">
          <RankingBars
            items={rankedAuthorIds.slice(0, 12).map((id) => ({
              id,
              label: labelOf(id),
              value: stats.authors.get(id) ?? 0,
            }))}
            palette={palette}
            colorOf={(id) => authorColors.colorOf(id)}
            onSelect={(id) => navigate(`/personnes/${encodeURIComponent(id)}`)}
            height={Math.max(180, Math.min(12, rankedAuthorIds.length) * 26)}
          />
        </Card>
      </div>

      <Card
        title="Commits récents"
        subtitle={`${formatNumber(recent.length)} derniers commits conservés localement`}
        bodyClassName="px-0 pb-0"
      >
        {recent.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
            Aucun commit récent mémorisé pour ce dépôt.
          </p>
        ) : (
          <ul className="max-h-[420px] divide-y divide-[var(--border)] overflow-y-auto">
            {recent.map((commit) => (
              <li key={commit.key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <SeriesDot color={authorColors.colorOf(commit.authorId)} />
                <a
                  href={commit.webUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="tnum shrink-0 font-mono text-xs text-[var(--series-1)] hover:underline"
                >
                  {commit.shortSha}
                </a>
                <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{commit.title}</span>
                <span
                  className="shrink-0 truncate text-xs text-[var(--text-muted)]"
                  title={labelOf(commit.authorId)}
                >
                  {labelOf(commit.authorId)}
                </span>
                {!commit.isMerge && (
                  <span className="tnum shrink-0 text-xs">
                    <span style={{ color: palette.divergingPositive }}>+{formatCompact(commit.additions)}</span>{' '}
                    <span style={{ color: palette.divergingNegative }}>−{formatCompact(commit.deletions)}</span>
                  </span>
                )}
                <span className="tnum shrink-0 text-xs text-[var(--text-muted)]">
                  {formatDay(commit.date.slice(0, 10))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Accès direct au Dataset pour les données non agrégées (fil des commits). */
function useAnalyticsDataset() {
  return useAppStore((state) => state.dataset);
}
