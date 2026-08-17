import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { FilterBar } from './FilterBar';
import { Button, cx, formatRelative, ProgressBar, formatNumber } from './ui/primitives';

const NAV = [
  { to: '/', label: 'Global', end: true },
  { to: '/projets', label: 'Projets', end: false },
  { to: '/personnes', label: 'Personnes', end: false },
  { to: '/comparer', label: 'Comparer', end: false },
];

/**
 * La barre de filtres n'apparaît que là où elle cadre réellement quelque chose.
 * L'afficher au-dessus des réglages ou de l'écran de sync laisserait croire
 * qu'elle agit dessus.
 */
const UNFILTERED_ROUTES = ['/reglages', '/sync'];

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const showFilters = !UNFILTERED_ROUTES.includes(location.pathname);
  const isSyncing = useAppStore((state) => state.isSyncing);
  const progress = useAppStore((state) => state.progress);
  const meta = useAppStore((state) => state.dataset.meta);
  const startSync = useAppStore((state) => state.startSync);
  const projectCount = useAppStore((state) => state.dataset.projects.size);

  return (
    <div className="min-h-screen bg-[var(--plane)]">
      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-5 py-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex cursor-pointer items-center gap-2.5"
          >
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-lg text-sm font-bold text-white"
              style={{ background: 'var(--series-1)' }}
            >
              G
            </span>
            <span className="text-sm font-semibold tracking-tight">GitStats</span>
          </button>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition',
                    isActive
                      ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {isSyncing ? (
              <button
                type="button"
                onClick={() => navigate('/sync')}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--border)] px-3 py-1.5"
              >
                <span className="relative flex h-2 w-2">
                  <span
                    className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
                    style={{ background: 'var(--series-1)' }}
                  />
                  <span
                    className="relative inline-flex h-2 w-2 rounded-full"
                    style={{ background: 'var(--series-1)' }}
                  />
                </span>
                <span className="w-28 text-left">
                  <span className="block text-xs text-[var(--text-secondary)]">
                    {formatNumber(progress?.projectsDone ?? 0)} / {formatNumber(progress?.projectsPlanned ?? 0)} dépôts
                  </span>
                  <span className="mt-1 block">
                    <ProgressBar
                      value={progress?.projectsDone ?? 0}
                      max={Math.max(1, progress?.projectsPlanned ?? 1)}
                    />
                  </span>
                </span>
              </button>
            ) : (
              <>
                <span className="hidden text-xs text-[var(--text-muted)] sm:block">
                  {projectCount > 0
                    ? `${formatNumber(projectCount)} dépôts · maj ${formatRelative(meta?.lastSyncAt ?? null)}`
                    : 'aucune donnée'}
                </span>
                <Button variant="primary" onClick={() => void startSync()}>
                  Synchroniser
                </Button>
              </>
            )}
            <NavLink
              to="/reglages"
              className={({ isActive }) =>
                cx(
                  'rounded-lg px-3 py-1.5 text-sm font-medium transition',
                  isActive
                    ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
                )
              }
            >
              Réglages
            </NavLink>
          </div>
        </div>
      </header>

      {showFilters && <FilterBar />}

      <main className="mx-auto max-w-[1600px] px-5 py-6">
        <Outlet />
      </main>
    </div>
  );
}
