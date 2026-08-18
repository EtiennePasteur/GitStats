import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useAnalytics } from '../query/useAnalytics';
import { InstanceManager } from '../components/InstanceManager';
import { detectMirrors, suggestExclusions } from '../sync/mirrors';
import { suggestMerges, type MergeSuggestion, type MergeKind } from '../sync/identity';
import { getStorageUsage, type StorageUsage } from '../store/db';
import type { StoredProject } from '../model/types';
import {
  isFileSystemAccessSupported,
  linkFile,
  unlinkFile,
  downloadFile,
  readFileFromInput,
  ensureWritePermission,
} from '../store/fileHandle';
import { serializeDataset, estimateFileSize } from '../store/serialize';
import {
  Card,
  Button,
  Toggle,
  Avatar,
  StatusBadge,
  formatNumber,
  formatBytes,
  formatDateTime,
  cx,
} from '../components/ui/primitives';

export function Settings() {
  const config = useAppStore((state) => state.config);
  const meta = useAppStore((state) => state.dataset.meta);
  const dataset = useAppStore((state) => state.dataset);
  const linkedFileName = useAppStore((state) => state.linkedFileName);
  const lastSaveError = useAppStore((state) => state.lastSaveError);
  const isSyncing = useAppStore((state) => state.isSyncing);
  const updateConfig = useAppStore((state) => state.updateConfig);
  const startSync = useAppStore((state) => state.startSync);
  const saveToFile = useAppStore((state) => state.saveToFile);
  const importFromText = useAppStore((state) => state.importFromText);
  const refreshLinkedFileName = useAppStore((state) => state.refreshLinkedFileName);
  const setManualAliases = useAppStore((state) => state.setManualAliases);
  const disconnect = useAppStore((state) => state.disconnect);

  const instances = useAppStore((state) => state.instances);
  /** Nom de fichier lisible : une instance ⇒ son libellé, sinon « multi ». */
  const exportLabel =
    instances.length === 1 ? (instances[0]?.label ?? 'gitlab') : `multi-${instances.length}`;

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void getStorageUsage().then(setUsage);
  }, [dataset]);

  const notify = (text: string) => {
    setMessage(text);
    setError(null);
    setTimeout(() => setMessage(null), 4000);
  };
  const fail = (caught: unknown) => {
    if (caught instanceof DOMException && caught.name === 'AbortError') return;
    setError(caught instanceof Error ? caught.message : String(caught));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {message !== null && (
        <p
          role="status"
          className="rounded-lg px-3 py-2 text-sm"
          style={{ background: 'color-mix(in oklab, var(--status-good) 12%, transparent)', color: 'var(--text-secondary)' }}
        >
          {message}
        </p>
      )}
      {error !== null && (
        <p
          role="alert"
          className="rounded-lg px-3 py-2 text-sm"
          style={{ background: 'color-mix(in oklab, var(--status-critical) 12%, transparent)', color: 'var(--status-critical)' }}
        >
          {error}
        </p>
      )}

      <Card
        title="Instances GitLab"
        subtitle="Les tokens ne sont jamais écrits en base : après une nouvelle session, ils sont à ressaisir."
      >
        <InstanceManager />
      </Card>

      <Card title="Collecte" subtitle="Options communes à toutes les instances.">
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              <span className="font-medium">Profondeur d'historique</span>
              <span className="block text-xs text-[var(--text-muted)]">
                Élargir ne re-télécharge que la période manquante.
              </span>
            </span>
            <select
              value={config.windowMonths === null ? 'all' : String(config.windowMonths)}
              onChange={(event) => {
                const value = event.target.value;
                void updateConfig({ windowMonths: value === 'all' ? null : Number(value) });
              }}
              className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 text-sm"
            >
              {[3, 6, 12, 24, 36, 48, 60].map((months) => (
                <option key={months} value={months}>
                  {months} mois
                </option>
              ))}
              <option value="all">Tout l'historique</option>
            </select>
          </label>

          <Toggle
            checked={config.withStats}
            onChange={(value) => void updateConfig({ withStats: value })}
            label="Compter les lignes ajoutées / supprimées"
            hint="Changer cette option force une nouvelle collecte complète : les anciens chiffres ne seraient pas comparables."
          />
          <Toggle
            checked={config.allBranches}
            onChange={(value) => void updateConfig({ allBranches: value })}
            label="Analyser toutes les branches"
            hint="Change également la nature des données collectées, donc relance une collecte complète."
          />
          <Toggle
            checked={config.includeArchived}
            onChange={(value) => void updateConfig({ includeArchived: value })}
            label="Inclure les dépôts archivés"
          />
        </div>
      </Card>

      <Card
        title="Débit vers GitLab"
        subtitle="Les en-têtes RateLimit de GitLab ne sont pas lisibles depuis un navigateur : le débit s'auto-régule sur les refus (429)."
      >
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="flex items-center justify-between">
              <span className="font-medium">Requêtes par minute</span>
              <span className="tnum text-[var(--text-secondary)]">{config.requestsPerMinute}</span>
            </span>
            <input
              type="range"
              min={60}
              max={1200}
              step={20}
              value={config.requestsPerMinute}
              onChange={(event) => void updateConfig({ requestsPerMinute: Number(event.target.value) })}
              className="mt-2 w-full accent-[var(--series-1)]"
            />
            <span className="text-xs text-[var(--text-muted)]">
              Plafond visé. GitLab autorise 2 000/min par défaut pour un utilisateur authentifié ; rester
              nettement en dessous évite de gêner les autres usages de l'instance.
            </span>
          </label>

          <label className="block text-sm">
            <span className="flex items-center justify-between">
              <span className="font-medium">Dépôts traités en parallèle</span>
              <span className="tnum text-[var(--text-secondary)]">{config.maxConcurrent}</span>
            </span>
            <input
              type="range"
              min={1}
              max={16}
              value={config.maxConcurrent}
              onChange={(event) => void updateConfig({ maxConcurrent: Number(event.target.value) })}
              className="mt-2 w-full accent-[var(--series-1)]"
            />
          </label>

          <div className="border-t border-[var(--border)] pt-4">
            <p className="text-sm font-medium">Resynchronisation complète</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Le mode incrémental repart 7 jours en arrière. Un commit ancien arrivé par le merge d'une
              branche plus vieille que ça n'est donc pas rattrapé. Cette action re-télécharge tout —
              même budget d'appels que la première collecte.
            </p>
            <Button
              className="mt-2"
              variant="danger"
              disabled={isSyncing}
              onClick={() => void startSync({ forceFullResync: true })}
            >
              Tout resynchroniser
            </Button>
          </div>
        </div>
      </Card>

      <MirrorDetector onDone={notify} />

      <MutedProjects onDone={notify} />

      <IdentityMerger onDone={notify} setManualAliases={setManualAliases} />

      <Card
        title="Fichier de données"
        subtitle={
          linkedFileName !== null
            ? `Lié à « ${linkedFileName} », réécrit automatiquement pendant les syncs.`
            : "Aucun fichier lié : les données ne vivent que dans ce navigateur."
        }
      >
        {lastSaveError !== null && (
          <p className="mb-3 text-xs" style={{ color: 'var(--status-critical)' }}>
            Dernière sauvegarde en échec : {lastSaveError}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {isFileSystemAccessSupported() ? (
            <>
              <Button
                variant="primary"
                onClick={() => {
                  void linkFile(exportLabel)
                    .then(async (name) => {
                      await saveToFile();
                      await refreshLinkedFileName();
                      notify(`Fichier « ${name} » lié et enregistré.`);
                    })
                    .catch(fail);
                }}
              >
                {linkedFileName !== null ? 'Changer de fichier' : 'Lier un fichier .json'}
              </Button>
              {linkedFileName !== null && (
                <>
                  <Button
                    onClick={() => {
                      void ensureWritePermission(true)
                        .then((granted) =>
                          granted
                            ? saveToFile().then(() => notify('Fichier mis à jour.'))
                            : Promise.reject(new Error("Autorisation d'écriture refusée.")),
                        )
                        .catch(fail);
                    }}
                  >
                    Enregistrer maintenant
                  </Button>
                  <Button
                    onClick={() => {
                      void unlinkFile()
                        .then(refreshLinkedFileName)
                        .then(() => notify('Fichier délié.'))
                        .catch(fail);
                    }}
                  >
                    Délier
                  </Button>
                </>
              )}
            </>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">
              Votre navigateur ne gère pas la liaison de fichier (API File System Access). Utilisez
              l'export et l'import manuels ci-dessous — même format.
            </p>
          )}

          <Button onClick={() => downloadFile(serializeDataset(dataset), exportLabel)}>
            Exporter un .json
          </Button>
          <Button onClick={() => fileInputRef.current?.click()}>Importer un .json</Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              void readFileFromInput(event.target)
                .then(importFromText)
                .then(() => notify('Données importées.'))
                .catch(fail);
            }}
          />
        </div>
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Le token n'est jamais écrit dans ce fichier : il peut être partagé sans risque.
          Taille estimée : {formatBytes(estimateFileSize(dataset))}.
        </p>
      </Card>

      <Card title="Stockage local" subtitle={`Dernière synchronisation : ${formatDateTime(meta?.lastSyncAt ?? null)}`}>
        {usage !== null && (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ['Dépôts', formatNumber(usage.projects)],
              ['Contributeurs', formatNumber(usage.authors)],
              ['Seaux journaliers', formatNumber(usage.daily)],
              ['Espace utilisé', formatBytes(usage.estimatedBytes)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
                <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
                <dd className="tnum mt-0.5 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
          <Button onClick={() => void disconnect(false)}>Se déconnecter</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (window.confirm('Effacer toutes les données locales ? Le fichier .json lié, lui, sera conservé.')) {
                void disconnect(true);
              }
            }}
          >
            Effacer les données locales
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * Fusion d'identités. Les propositions sont classées par confiance et ne sont
 * JAMAIS appliquées automatiquement : rattacher à tort deux personnes fausse
 * durablement toutes les comparaisons, et rien dans l'interface ne le signalerait.
 */
const KIND_LABEL: Record<MergeKind, string> = {
  email: 'Même identifiant e-mail',
  name: 'Même nom et prénom',
  login: 'Login correspondant au nom',
};

const KIND_HINT: Record<MergeKind, string> = {
  email: "La partie avant le @ est identique sur deux domaines — indice très fiable.",
  name: "Adresses sans rapport, mais même état civil : typiquement une adresse pro et une adresse perso. Vérifiez qu'il ne s'agit pas de deux homonymes.",
  login: "L'identifiant e-mail de l'un reconstitue le nom de l'autre.",
};

const VISIBLE_PER_KIND = 6;

function IdentityMerger({
  onDone,
  setManualAliases,
}: {
  onDone: (message: string) => void;
  setManualAliases: (aliases: Record<string, string>) => Promise<void>;
}) {
  const { authorsById, authors: authorStats, labelOf } = useAnalytics();
  const meta = useAppStore((state) => state.dataset.meta);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<MergeKind>>(new Set());
  const [manualPair, setManualPair] = useState<string[]>([]);
  const [manualQuery, setManualQuery] = useState('');

  const authors = useMemo(() => [...authorsById.values()], [authorsById]);

  const grouped = useMemo(() => {
    const pairKey = (s: MergeSuggestion) => s.authorIds.slice().sort().join('|');
    const all = suggestMerges(authors).filter((s) => !dismissed.has(pairKey(s)));
    const groups = new Map<MergeKind, MergeSuggestion[]>();
    for (const suggestion of all) {
      const bucket = groups.get(suggestion.kind);
      if (bucket) bucket.push(suggestion);
      else groups.set(suggestion.kind, [suggestion]);
    }
    return groups;
  }, [authors, dismissed]);

  const total = [...grouped.values()].reduce((sum, list) => sum + list.length, 0);
  const aliases = meta?.manualAliases ?? {};
  const merged = Object.entries(aliases);

  /** Nombre de commits, pour proposer de garder l'identité la plus significative. */
  const commitsOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of authorStats) map.set(entry.authorId, entry.commits);
    return map;
  }, [authorStats]);

  const apply = (from: string, to: string) => {
    void setManualAliases({ ...aliases, [from]: to }).then(() =>
      // La fusion est résolue à la lecture : elle est visible tout de suite.
      onDone(`Fusion appliquée — « ${labelOf(from)} » rejoint « ${labelOf(to)} ».`),
    );
  };

  const undo = (from: string) => {
    const next = { ...aliases };
    delete next[from];
    void setManualAliases(next).then(() => onDone('Fusion annulée.'));
  };

  const manualCandidates = useMemo(() => {
    const needle = manualQuery.trim().toLowerCase();
    return authors
      .filter((author) => {
        if (manualPair.includes(author.id)) return true;
        if (needle === '') return false;
        return (
          author.displayName.toLowerCase().includes(needle) ||
          author.knownEmails.some((email) => email.includes(needle))
        );
      })
      .slice(0, 8);
  }, [authors, manualQuery, manualPair]);

  const toggleManual = (id: string) => {
    setManualPair((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (current.length >= 2) return [current[1]!, id];
      return [...current, id];
    });
  };

  return (
    <Card
      title="Identités des contributeurs"
      subtitle={`${formatNumber(authors.length)} personnes. Regroupement automatique par e-mail, rapprochements par nom proposés ci-dessous.`}
    >
      {total === 0 && merged.length === 0 && (
        <p className="text-sm text-[var(--text-muted)]">
          Aucun rapprochement détecté : les identités semblent déjà distinctes.
        </p>
      )}

      {total > 0 && (
        <p className="mb-3 text-xs text-[var(--text-muted)]">
          {formatNumber(total)} rapprochement(s) possible(s). Rien n'est fusionné sans votre
          validation : réunir à tort deux personnes fausserait durablement les comparaisons.
        </p>
      )}

      {(['email', 'name', 'login'] as const).map((kind) => {
        const list = grouped.get(kind);
        if (list === undefined || list.length === 0) return null;
        const isOpen = expanded.has(kind);
        const visible = isOpen ? list : list.slice(0, VISIBLE_PER_KIND);

        return (
          <div key={kind} className="mb-4 last:mb-0">
            <div className="mb-1.5 flex items-baseline gap-2">
              <h3 className="text-xs font-semibold text-[var(--text-secondary)]">
                {KIND_LABEL[kind]}
              </h3>
              <span className="tnum text-xs text-[var(--text-muted)]">{formatNumber(list.length)}</span>
            </div>
            <p className="mb-2 text-xs text-[var(--text-muted)]">{KIND_HINT[kind]}</p>

            <ul className="space-y-2">
              {visible.map((suggestion) => {
                const [a, b] = suggestion.authorIds;
                const authorA = authorsById.get(a);
                const authorB = authorsById.get(b);
                if (!authorA || !authorB) return null;
                const key = suggestion.authorIds.slice().sort().join('|');
                // On propose par défaut de conserver l'identité qui pèse le plus
                // de commits : c'est presque toujours l'adresse professionnelle.
                const aWins = (commitsOf.get(a) ?? 0) >= (commitsOf.get(b) ?? 0);
                const [keep, drop] = aWins ? [authorA, authorB] : [authorB, authorA];

                return (
                  <li key={key} className="rounded-lg border border-[var(--border)] px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <Avatar name={keep.displayName} />
                      <span className="min-w-0 truncate">
                        {keep.displayName}
                        <span className="ml-1.5 text-xs text-[var(--text-muted)]">
                          {keep.primaryEmail} · {formatNumber(commitsOf.get(keep.id) ?? 0)} commits
                        </span>
                      </span>
                      <span className="shrink-0 text-[var(--text-muted)]">↔</span>
                      <Avatar name={drop.displayName} />
                      <span className="min-w-0 truncate">
                        {drop.displayName}
                        <span className="ml-1.5 text-xs text-[var(--text-muted)]">
                          {drop.primaryEmail} · {formatNumber(commitsOf.get(drop.id) ?? 0)} commits
                        </span>
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <StatusBadge tone={suggestion.confidence >= 0.85 ? 'good' : 'warning'}>
                        {suggestion.reason}
                      </StatusBadge>
                      <span className="flex gap-1.5">
                        <Button variant="primary" onClick={() => apply(drop.id, keep.id)}>
                          Fusionner sous « {keep.displayName} »
                        </Button>
                        <Button onClick={() => apply(keep.id, drop.id)}>
                          Plutôt « {drop.displayName} »
                        </Button>
                        <Button
                          variant="subtle"
                          onClick={() => setDismissed((current) => new Set(current).add(key))}
                        >
                          Ignorer
                        </Button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>

            {list.length > VISIBLE_PER_KIND && (
              <button
                type="button"
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(kind)) next.delete(kind);
                    else next.add(kind);
                    return next;
                  })
                }
                className="mt-2 cursor-pointer text-xs text-[var(--series-1)] hover:underline"
              >
                {isOpen
                  ? 'Réduire'
                  : `Voir les ${formatNumber(list.length - VISIBLE_PER_KIND)} autres`}
              </button>
            )}
          </div>
        );
      })}

      <div className="mt-4 border-t border-[var(--border)] pt-4">
        <p className="text-sm font-medium">Fusionner manuellement</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Pour les cas qu'aucun indice ne rapproche : surnom, nom marital, faute de frappe. Cherchez
          puis sélectionnez deux personnes.
        </p>
        <input
          type="search"
          value={manualQuery}
          onChange={(event) => setManualQuery(event.target.value)}
          placeholder="Nom ou adresse e-mail…"
          className="mt-2 h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
        />

        {manualCandidates.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {manualCandidates.map((author) => {
              const active = manualPair.includes(author.id);
              return (
                <button
                  key={author.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleManual(author.id)}
                  className={cx(
                    'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1 text-sm transition',
                    active
                      ? 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-primary)]'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                  )}
                >
                  <Avatar name={author.displayName} size={18} />
                  <span className="max-w-[220px] truncate">{author.displayName}</span>
                  <span className="text-xs text-[var(--text-muted)]">{author.primaryEmail}</span>
                </button>
              );
            })}
          </div>
        )}

        {manualPair.length === 2 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--text-muted)]">Conserver l'identité de :</span>
            {manualPair.map((id, index) => {
              const other = manualPair[1 - index]!;
              return (
                <Button
                  key={id}
                  variant={index === 0 ? 'primary' : 'ghost'}
                  onClick={() => {
                    apply(other, id);
                    setManualPair([]);
                    setManualQuery('');
                  }}
                >
                  {labelOf(id)}
                </Button>
              );
            })}
            <Button variant="subtle" onClick={() => setManualPair([])}>
              Annuler
            </Button>
          </div>
        )}
      </div>

      {merged.length > 0 && (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">
            Fusions actives ({formatNumber(merged.length)})
          </p>
          <ul className="space-y-1">
            {merged.map(([from, to]) => (
              <li key={from} className="flex items-center gap-2 text-sm">
                <code className="min-w-0 truncate text-xs text-[var(--text-muted)]">{from}</code>
                <span className="shrink-0 text-[var(--text-muted)]">→</span>
                <span className="min-w-0 truncate text-xs" title={labelOf(to)}>{labelOf(to)}</span>
                <Button variant="subtle" className="ml-auto shrink-0" onClick={() => undo(from)}>
                  Annuler
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/**
 * Dépôts mirrorés entre instances.
 *
 * Deux dépôts qui partagent un SHA de commit sont le même code — un SHA est un
 * hachage de tout l'historique. Sans exclusion, ils comptent double : commits,
 * lignes et classements sont gonflés en silence.
 */
function MirrorDetector({ onDone }: { onDone: (message: string) => void }) {
  const dataset = useAppStore((state) => state.dataset);
  const dataVersion = useAppStore((state) => state.dataVersion);
  const instances = useAppStore((state) => state.instances);
  const setProjectExcluded = useAppStore((state) => state.setProjectExcluded);
  const { projects: projectStats, projectsById } = useAnalytics();

  const groups = useMemo(() => {
    const shas = new Map<string, string[]>();
    for (const commit of dataset.recentCommits.values()) {
      const bucket = shas.get(commit.projectKey);
      if (bucket === undefined) shas.set(commit.projectKey, [commit.sha]);
      else bucket.push(commit.sha);
    }
    return detectMirrors(dataset.projects.values(), shas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, dataVersion]);

  const commitsByProject = useMemo(
    () => new Map(projectStats.map((entry) => [entry.projectKey, entry.commits])),
    [projectStats],
  );

  // Une seule instance : la question ne se pose pas.
  if (instances.length < 2 && groups.length === 0) return null;

  const labelOf = (id: string) => instances.find((entry) => entry.id === id)?.label ?? id;

  return (
    <Card
      title="Dépôts en double entre instances"
      subtitle="Détectés par SHA de commit partagés — deux dépôts partageant un commit sont forcément le même code."
    >
      {groups.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          Aucun dépôt commun détecté entre vos instances : rien n'est compté deux fois.
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs text-[var(--text-muted)]">
            {formatNumber(groups.length)} groupe(s) détecté(s). Sans exclusion, leurs commits et
            leurs lignes sont comptés une fois par instance.
          </p>
          <ul className="space-y-2">
            {groups.map((group) => {
              const toExclude = new Set(suggestExclusions([group], commitsByProject));
              return (
                <li
                  key={group.projectKeys.join('|')}
                  className="rounded-lg border border-[var(--border)] px-3 py-2.5"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-[var(--text-muted)]">
                      {formatNumber(group.sharedShaCount)} commit(s) en commun
                    </span>
                    <StatusBadge tone="warning">{group.instanceIds.map(labelOf).join(' ↔ ')}</StatusBadge>
                  </div>
                  <ul className="space-y-1">
                    {group.projectKeys.map((key) => {
                      const project = projectsById.get(key);
                      const excluded = project?.excluded === true;
                      const suggested = toExclude.has(key);
                      return (
                        <li key={key} className="flex items-center gap-2 text-sm">
                          <span
                            className={cx(
                              'min-w-0 flex-1 truncate',
                              excluded && 'text-[var(--text-muted)] line-through',
                            )}
                          >
                            {project?.pathWithNamespace ?? key}
                            <span className="ml-2 text-xs text-[var(--text-muted)]">
                              {labelOf(project?.instanceId ?? '')} ·{' '}
                              {formatNumber(commitsByProject.get(key) ?? 0)} commits
                            </span>
                          </span>
                          {suggested && !excluded && (
                            <span className="shrink-0 text-xs text-[var(--text-muted)]">
                              doublon probable
                            </span>
                          )}
                          <Button
                            variant={excluded ? 'ghost' : suggested ? 'primary' : 'subtle'}
                            onClick={() => {
                              void setProjectExcluded(key, !excluded).then(() =>
                                onDone(excluded ? 'Dépôt réintégré.' : 'Dépôt écarté des statistiques.'),
                              );
                            }}
                          >
                            {excluded ? 'Réintégrer' : 'Exclure'}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

/**
 * Dépôts retirés des statistiques sur décision de l'utilisateur.
 *
 * À ne pas confondre avec les doublons de la carte précédente : un miroir n'est
 * PAS comptable, alors qu'ici le dépôt l'est parfaitement — on choisit seulement
 * de ne pas le compter. Un dépôt de configuration que toute l'équipe touche tous
 * les jours écrase sinon tous les classements sans rien dire de l'activité réelle.
 *
 * C'est le seul inventaire exhaustif : la route Projets ne liste que les dépôts
 * actifs sur la période, et masque les ignorés tant que l'interrupteur de la
 * barre de filtres est fermé.
 */
function MutedProjects({ onDone }: { onDone: (message: string) => void }) {
  const dataset = useAppStore((state) => state.dataset);
  const dataVersion = useAppStore((state) => state.dataVersion);
  const setProjectMuted = useAppStore((state) => state.setProjectMuted);
  const [query, setQuery] = useState('');

  const byPath = (a: StoredProject, b: StoredProject): number =>
    a.pathWithNamespace.localeCompare(b.pathWithNamespace, 'fr');

  const muted = useMemo(
    () => [...dataset.projects.values()].filter((project) => project.muted === true).sort(byPath),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, dataVersion],
  );

  const needle = query.trim().toLowerCase();
  // Bornée : taper « a » sur un parc de 234 dépôts ne doit pas dérouler tout le parc.
  const candidates = useMemo(() => {
    if (needle === '') return [];
    return [...dataset.projects.values()]
      .filter(
        (project) =>
          project.muted !== true &&
          (project.nameWithNamespace.toLowerCase().includes(needle) ||
            project.pathWithNamespace.toLowerCase().includes(needle)),
      )
      .sort(byPath)
      .slice(0, 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, dataVersion, needle]);

  return (
    <Card
      title="Dépôts ignorés"
      subtitle="Retirés des statistiques, mais toujours synchronisés. L'interrupteur « Masquer les dépôts ignorés » de la barre de filtres les réaffiche à la demande."
    >
      {muted.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          Aucun dépôt ignoré : tout ce qui est collecté est compté.
        </p>
      ) : (
        <ul className="space-y-1">
          {muted.map((project) => (
            <li key={project.key} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-[var(--text-muted)] line-through">
                {project.pathWithNamespace}
              </span>
              {project.excluded === true && <StatusBadge tone="warning">doublon</StatusBadge>}
              <Button
                onClick={() => {
                  void setProjectMuted(project.key, false).then(() => onDone('Dépôt réintégré.'));
                }}
              >
                Réintégrer
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-[var(--border)] pt-4">
        <p className="text-sm font-medium">Ignorer un dépôt</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Pour ceux que tout le monde touche sans que cela dise rien de l'activité : configuration,
          gabarits, documentation partagée.
        </p>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Nom ou chemin du dépôt…"
          className="mt-2 h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
        />
        {needle !== '' && candidates.length === 0 && (
          <p className="mt-2 text-xs text-[var(--text-muted)]">Aucun dépôt ne correspond.</p>
        )}
        {candidates.length > 0 && (
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {candidates.map((project) => (
              <li key={project.key} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                  {project.pathWithNamespace}
                </span>
                {project.excluded === true ? (
                  // Déjà écarté comme doublon : l'ignorer en plus ne changerait rien,
                  // et le bouton laisserait croire qu'il compte encore.
                  <StatusBadge tone="warning">déjà écarté</StatusBadge>
                ) : (
                  <Button
                    variant="subtle"
                    onClick={() => {
                      void setProjectMuted(project.key, true).then(() =>
                        onDone('Dépôt retiré des statistiques.'),
                      );
                    }}
                  >
                    Ignorer
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
