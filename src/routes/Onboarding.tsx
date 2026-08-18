import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { InstanceManager } from '../components/InstanceManager';
import { Button, Toggle, cx } from '../components/ui/primitives';
import { readFileFromInput, isFileSystemAccessSupported, pickExistingFile } from '../store/fileHandle';

const WINDOWS: Array<{ months: number | null; label: string; hint: string }> = [
  { months: 3, label: '3 mois', hint: '~1 min' },
  { months: 6, label: '6 mois', hint: '~2 min' },
  { months: 12, label: '12 mois', hint: '~3 à 7 min' },
  { months: 24, label: '24 mois', hint: '~10 min' },
  { months: 36, label: '36 mois', hint: '~15 min' },
  { months: 48, label: '48 mois', hint: '~20 min' },
  { months: 60, label: '60 mois', hint: '~25 min' },
  { months: null, label: 'Tout', hint: 'peut être long' },
];

export function Onboarding() {
  const navigate = useNavigate();
  const instances = useAppStore((state) => state.instances);
  const tokens = useAppStore((state) => state.tokens);
  const updateConfig = useAppStore((state) => state.updateConfig);
  const startSync = useAppStore((state) => state.startSync);
  const importFromText = useAppStore((state) => state.importFromText);
  const storedConfig = useAppStore((state) => state.config);

  const [windowMonths, setWindowMonths] = useState<number | null>(storedConfig.windowMonths);
  const [allBranches, setAllBranches] = useState(storedConfig.allBranches);
  const [withStats, setWithStats] = useState(storedConfig.withStats);
  const [includeArchived, setIncludeArchived] = useState(storedConfig.includeArchived);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** Au moins une instance dont on détient le token : l'analyse peut démarrer. */
  const ready = instances.some(
    (instance) => typeof tokens[instance.id] === 'string' && tokens[instance.id] !== '',
  );

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateConfig({ windowMonths, allBranches, withStats, includeArchived });
      navigate('/sync');
      void startSync({ windowMonths, allBranches, withStats, includeArchived });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const importText = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      await importFromText(text);
      navigate('/');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-5 py-12">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid h-10 w-10 place-items-center rounded-xl text-lg font-bold text-white"
            style={{ background: 'var(--series-1)' }}
          >
            G
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">GitStats</h1>
        </div>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          Statistiques Git de tout votre parc GitLab, sur une ou plusieurs instances. Tout s'exécute
          dans votre navigateur : vos tokens ne sont envoyés qu'à leur instance respective, jamais ailleurs.
        </p>
      </div>

      <div className="space-y-5 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <InstanceManager />

        <div className="border-t border-[var(--border)] pt-4">
          <span className="text-sm font-medium">Profondeur d'historique</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {WINDOWS.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => setWindowMonths(option.months)}
                className={cx(
                  'cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition',
                  windowMonths === option.months
                    ? 'border-transparent bg-[var(--series-1)] text-white'
                    : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                )}
              >
                {option.label}
                <span
                  className={cx(
                    'ml-1.5 text-xs',
                    windowMonths === option.months ? 'text-white/70' : 'text-[var(--text-muted)]',
                  )}
                >
                  {option.hint}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Élargissable plus tard sans tout re-télécharger : seule la période manquante sera récupérée.
          </p>
        </div>

        <div className="space-y-3 border-t border-[var(--border)] pt-4">
          <Toggle
            checked={withStats}
            onChange={setWithStats}
            label="Compter les lignes ajoutées / supprimées"
            hint="Fait calculer un diff par commit côté GitLab : plus lent, mais indispensable pour les volumes de code."
          />
          <Toggle
            checked={allBranches}
            onChange={setAllBranches}
            label="Toutes les branches"
            hint="Par défaut, seule la branche principale est analysée — c'est la mesure la plus fidèle du travail intégré."
          />
          <Toggle
            checked={includeArchived}
            onChange={setIncludeArchived}
            label="Inclure les dépôts archivés"
          />
        </div>

        {error !== null && (
          <p
            role="alert"
            className="rounded-lg border px-3 py-2 text-sm"
            style={{
              borderColor: 'var(--status-critical)',
              color: 'var(--status-critical)',
              background: 'color-mix(in oklab, var(--status-critical) 10%, transparent)',
            }}
          >
            {error}
          </p>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
          <span className="text-xs text-[var(--text-muted)]">
            {ready
              ? `${instances.length} instance(s) prête(s). Les données de toutes les instances seront agrégées.`
              : 'Ajoutez au moins une instance pour lancer l’analyse.'}
          </span>
          <Button variant="primary" onClick={() => void launch()} disabled={busy || !ready}>
            {busy ? 'Démarrage…' : 'Lancer l’analyse'}
          </Button>
        </div>
      </div>

      <div className="mt-5 rounded-xl border border-dashed border-[var(--border)] p-4">
        <p className="text-sm font-medium">Déjà un fichier de données&nbsp;?</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Rechargez un export <code>.json</code> pour consulter les tableaux de bord sans aucun appel réseau.
        </p>
        <div className="mt-3 flex gap-2">
          {isFileSystemAccessSupported() && (
            <Button
              onClick={() => {
                void pickExistingFile()
                  .then(({ text }) => importText(text))
                  .catch((caught: unknown) => {
                    // Une annulation du sélecteur de fichier n'est pas une erreur.
                    if (caught instanceof DOMException && caught.name === 'AbortError') return;
                    setError(caught instanceof Error ? caught.message : String(caught));
                  });
              }}
            >
              Ouvrir un fichier lié
            </Button>
          )}
          <Button onClick={() => fileInputRef.current?.click()}>Importer un .json</Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              void readFileFromInput(event.target)
                .then(importText)
                .catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : String(caught)),
                );
            }}
          />
        </div>
      </div>
    </div>
  );
}
