/**
 * Écran de synchronisation.
 *
 * Objectif : rendre l'attente lisible. À tout instant on sait combien de dépôts
 * restent, à quel débit on interroge GitLab, ce que fait chaque dépôt, et si le
 * serveur nous freine. Les tableaux de bord restent consultables pendant ce temps.
 */

import { useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppStore } from '../store/useAppStore';
import type { ProjectProgress } from '../sync/engine';
import type { InstanceProgress } from '../sync/coordinator';
import type { ProjectSyncState } from '../model/types';
import {
  Button,
  Card,
  StatTile,
  StatusBadge,
  ProgressBar,
  EmptyState,
  cx,
  formatNumber,
  formatDuration,
  type StatusTone,
} from '../components/ui/primitives';

const STATE_LABEL: Record<ProjectSyncState, string> = {
  pending: 'en file',
  overview: 'aperçu',
  commits: 'commits',
  done: 'terminé',
  skipped: 'inchangé, ignoré',
  empty: 'dépôt vide',
  error: 'erreur',
};

const STATE_TONE: Record<ProjectSyncState, StatusTone> = {
  pending: 'neutral',
  overview: 'accent',
  commits: 'accent',
  done: 'good',
  skipped: 'neutral',
  empty: 'neutral',
  error: 'critical',
};

const STATE_ORDER: Record<ProjectSyncState, number> = {
  error: 0,
  commits: 1,
  overview: 2,
  pending: 3,
  done: 4,
  empty: 5,
  skipped: 6,
};

export function SyncDashboard() {
  const navigate = useNavigate();
  const progress = useAppStore((state) => state.progress);
  const isSyncing = useAppStore((state) => state.isSyncing);
  const pauseSync = useAppStore((state) => state.pauseSync);
  const resumeSync = useAppStore((state) => state.resumeSync);
  const cancelSync = useAppStore((state) => state.cancelSync);
  const startSync = useAppStore((state) => state.startSync);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Les dépôts qui demandent de l'attention remontent : ce qui est terminé ou
  // ignoré n'a pas besoin d'être regardé.
  const projects = useMemo(() => {
    const list = progress?.projects ?? [];
    return [...list].sort(
      (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.pathWithNamespace.localeCompare(b.pathWithNamespace),
    );
  }, [progress]);

  const virtualizer = useVirtualizer({
    count: projects.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 15,
  });

  if (progress === null) {
    return (
      <EmptyState title="Aucune synchronisation en cours">
        Lancez une synchronisation pour collecter les statistiques de vos dépôts.
        <div className="mt-4">
          <Button variant="primary" onClick={() => void startSync()}>
            Synchroniser maintenant
          </Button>
        </div>
      </EmptyState>
    );
  }

  const paused = progress.phase === 'paused';
  const finished = progress.phase === 'done' || progress.phase === 'cancelled' || progress.phase === 'error';
  const totalToProcess = Math.max(1, progress.projectsPlanned);
  const processed = progress.projectsDone + progress.projectsError;
  const throttled = progress.rate.throttled;

  return (
    <div className="space-y-5">
      <Card
        title={
          <span className="flex items-center gap-2.5">
            {!finished && (
              <span className="relative flex h-2 w-2">
                <span
                  className={cx('absolute inline-flex h-full w-full rounded-full opacity-75', !paused && 'animate-ping')}
                  style={{ background: paused ? 'var(--status-warning)' : 'var(--series-1)' }}
                />
                <span
                  className="relative inline-flex h-2 w-2 rounded-full"
                  style={{ background: paused ? 'var(--status-warning)' : 'var(--series-1)' }}
                />
              </span>
            )}
            {progress.message || 'Synchronisation'}
          </span>
        }
        actions={
          <div className="flex gap-2">
            {isSyncing && !finished && (
              <>
                {paused ? (
                  <Button variant="primary" onClick={resumeSync}>
                    Reprendre
                  </Button>
                ) : (
                  <Button onClick={pauseSync}>Pause</Button>
                )}
                <Button variant="danger" onClick={cancelSync}>
                  Annuler
                </Button>
              </>
            )}
            {finished && (
              <>
                <Button variant="primary" onClick={() => navigate('/')}>
                  Voir les statistiques
                </Button>
                <Button onClick={() => void startSync()}>Relancer</Button>
              </>
            )}
          </div>
        }
      >
        <ProgressBar
          value={processed}
          max={totalToProcess}
          tone={progress.phase === 'error' ? 'critical' : paused ? 'warning' : 'accent'}
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-[var(--text-muted)]">
          <span className="tnum">
            {formatNumber(processed)} / {formatNumber(progress.projectsPlanned)} dépôts à traiter
          </span>
          {progress.projectsSkipped > 0 && (
            <span className="tnum">{formatNumber(progress.projectsSkipped)} inchangés, ignorés</span>
          )}
          <span className="tnum">écoulé {formatDuration(progress.elapsedMs)}</span>
          {progress.etaMs !== null && !finished && (
            <span className="tnum">reste ≈ {formatDuration(progress.etaMs)}</span>
          )}
        </div>

        {throttled && (
          <p
            role="status"
            className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
            style={{
              background: 'color-mix(in oklab, var(--status-warning) 12%, transparent)',
              color: 'var(--text-secondary)',
            }}
          >
            <span aria-hidden className="mt-0.5 h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--status-warning)' }} />
            <span>
              GitLab a renvoyé {formatNumber(progress.rate.penalties)} refus pour excès de débit. Le rythme
              a été réduit automatiquement à {formatNumber(progress.rate.currentRpm)} req/min (cible{' '}
              {formatNumber(progress.rate.targetRpm)}) et remontera progressivement. Rien n'est perdu :
              les requêtes concernées sont réessayées.
            </span>
          </p>
        )}

        {progress.fatalError !== null && (
          <p
            role="alert"
            className="mt-3 rounded-lg px-3 py-2 text-xs"
            style={{
              background: 'color-mix(in oklab, var(--status-critical) 12%, transparent)',
              color: 'var(--status-critical)',
            }}
          >
            {progress.fatalError}
          </p>
        )}
      </Card>

      {progress.instances.length > 1 && (
        <div className="grid gap-3 md:grid-cols-2">
          {progress.instances.map((entry) => (
            <InstanceCard key={entry.instanceId} instance={entry} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="Commits ingérés" value={formatNumber(progress.commitsIngested)} />
        <StatTile label="Appels API" value={formatNumber(progress.requestsMade)} />
        <StatTile
          label="Débit"
          value={`${formatNumber(progress.rate.observedRpm)}/min`}
          hint={`plafond ${formatNumber(progress.rate.currentRpm)} · ${progress.rate.active} en vol`}
          accent={throttled ? 'var(--status-warning)' : undefined}
        />
        <StatTile
          label="Aperçus"
          value={`${formatNumber(progress.overviewsDone)} / ${formatNumber(progress.overviewsPlanned)}`}
        />
        <StatTile
          label="En erreur"
          value={formatNumber(progress.projectsError)}
          accent={progress.projectsError > 0 ? 'var(--status-critical)' : undefined}
        />
      </div>

      <Card
        title="Dépôts"
        subtitle="Les dépôts nécessitant une attention apparaissent en premier."
        bodyClassName="px-0 pb-0"
      >
        <div ref={scrollRef} className="max-h-[480px] overflow-y-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const project = projects[item.index];
              if (project === undefined) return null;
              return (
                <ProjectRow
                  key={project.key}
                  project={project}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: 40,
                    transform: `translateY(${item.start}px)`,
                  }}
                />
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}

function ProjectRow({ project, style }: { project: ProjectProgress; style: React.CSSProperties }) {
  const busy = project.state === 'commits' || project.state === 'overview';
  return (
    <div
      style={style}
      className="flex items-center gap-3 border-b border-[var(--border)] px-4 text-sm"
    >
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
        {project.pathWithNamespace}
      </span>

      {project.state === 'pending' ? (
        <span className="skeleton h-3 w-24 rounded" />
      ) : (
        <>
          {project.commitsIngested > 0 && (
            <span className="tnum text-xs text-[var(--text-muted)]">
              {formatNumber(project.commitsIngested)} commits
            </span>
          )}
          {busy && project.currentPage > 0 && (
            <span className="tnum text-xs text-[var(--text-muted)]">page {project.currentPage}</span>
          )}
        </>
      )}

      <StatusBadge tone={STATE_TONE[project.state]}>{STATE_LABEL[project.state]}</StatusBadge>

      {project.error !== null && (
        <span className="max-w-[240px] truncate text-xs" style={{ color: 'var(--status-critical)' }} title={project.error}>
          {project.error}
        </span>
      )}
    </div>
  );
}

/** Progression d'une instance : chacune a son propre débit et ses propres erreurs. */
function InstanceCard({ instance }: { instance: InstanceProgress }) {
  const processed = instance.projectsDone + instance.projectsError;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{instance.label}</span>
        <StatusBadge
          tone={
            instance.error !== null
              ? 'critical'
              : instance.phase === 'done'
                ? 'good'
                : instance.rate.throttled
                  ? 'warning'
                  : 'accent'
          }
        >
          {instance.error !== null ? 'erreur' : (instance.message || instance.phase)}
        </StatusBadge>
      </div>

      <div className="mt-2">
        <ProgressBar
          value={processed}
          max={Math.max(1, instance.projectsPlanned)}
          tone={instance.error !== null ? 'critical' : 'accent'}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--text-muted)]">
        <span className="tnum">
          {formatNumber(processed)} / {formatNumber(instance.projectsPlanned)} dépôts
        </span>
        {instance.projectsSkipped > 0 && (
          <span className="tnum">{formatNumber(instance.projectsSkipped)} inchangés</span>
        )}
        <span className="tnum">{formatNumber(instance.commitsIngested)} commits</span>
        <span className="tnum">{formatNumber(instance.rate.observedRpm)} req/min</span>
        <span className="tnum">{formatNumber(instance.requestsMade)} appels</span>
      </div>

      {instance.error !== null && (
        <p className="mt-2 text-xs" style={{ color: 'var(--status-critical)' }}>
          {instance.error} — les autres instances ne sont pas affectées.
        </p>
      )}
    </div>
  );
}
