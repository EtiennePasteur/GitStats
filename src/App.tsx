import { useEffect } from 'react';
import { createHashRouter, RouterProvider, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAppStore } from './store/useAppStore';
import { useFilterStore } from './store/useFilterStore';
import { AppShell } from './components/AppShell';
import { Onboarding } from './routes/Onboarding';
import { SyncDashboard } from './routes/SyncDashboard';
import { Global } from './routes/Global';
import { Projects, ProjectDetail } from './routes/Projects';
import { People, PersonDetail } from './routes/People';
import { Compare } from './routes/Compare';
import { Settings } from './routes/Settings';
import { Skeleton } from './components/ui/primitives';
import { dataExtent } from './query/selectors';

/**
 * L'écran d'accueil vit DANS le routeur : il utilise `useNavigate` pour envoyer
 * l'utilisateur vers l'écran de synchronisation une fois le token validé, et
 * un composant monté hors `<RouterProvider>` n'a pas accès au contexte de
 * navigation.
 */
function RequireData() {
  const status = useAppStore((state) => state.status);
  const location = useLocation();
  if (status === 'onboarding') {
    return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

function OnboardingRoute() {
  const status = useAppStore((state) => state.status);
  if (status === 'ready') return <Navigate to="/" replace />;
  return <Onboarding />;
}

// Routage par hash : l'app se dépose telle quelle sur n'importe quel hébergement
// statique, sans règle de réécriture côté serveur.
const router = createHashRouter([
  { path: '/connexion', element: <OnboardingRoute /> },
  {
    element: <RequireData />,
    children: [
      {
        path: '/',
        element: <AppShell />,
        children: [
          { index: true, element: <Global /> },
          { path: 'sync', element: <SyncDashboard /> },
          { path: 'projets', element: <Projects /> },
          { path: 'projets/:key', element: <ProjectDetail /> },
          { path: 'personnes', element: <People /> },
          { path: 'personnes/:id', element: <PersonDetail /> },
          { path: 'comparer', element: <Compare /> },
          { path: 'reglages', element: <Settings /> },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);

export function App() {
  const status = useAppStore((state) => state.status);
  const bootError = useAppStore((state) => state.bootError);
  const boot = useAppStore((state) => state.boot);
  const dataset = useAppStore((state) => state.dataset);
  const dataVersion = useAppStore((state) => state.dataVersion);
  const setPreset = useFilterStore((state) => state.setPreset);
  const preset = useFilterStore((state) => state.preset);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Au premier chargement des données, on cadre la période sur ce qui est
  // réellement couvert plutôt que de laisser des bornes nulles.
  const hasData = dataVersion > 0 && dataset.daily.size > 0;
  useEffect(() => {
    if (!hasData || preset !== 'all') return;
    setPreset('all', dataExtent(dataset.daily.values()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasData]);

  if (status === 'unavailable') {
    return (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-lg font-semibold">Stockage local inaccessible</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          La base locale n'a pas pu être ouverte. Supprimez-la depuis les outils de
          développement du navigateur (Application → IndexedDB → « gitstats »), puis
          rechargez la page.
        </p>
        {bootError !== null && (
          <p className="mt-3 font-mono text-xs text-[var(--text-muted)]">{bootError}</p>
        )}
      </div>
    );
  }

  if (status === 'booting') {
    return (
      <div className="mx-auto max-w-[1600px] space-y-4 p-8">
        <Skeleton className="h-10 w-56" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return <RouterProvider router={router} />;
}
