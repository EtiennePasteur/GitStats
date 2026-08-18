/**
 * Barre de filtres unique, posée AU-DESSUS de tout ce qu'elle cadre.
 *
 * Il n'existe volontairement aucun filtre à l'intérieur d'une carte : deux
 * graphiques voisins doivent toujours parler du même périmètre, sinon la
 * comparaison visuelle qu'ils invitent à faire est fausse.
 */

import { useState, useRef, useEffect } from 'react';
import { useFilterStore, rangeForPreset, type DatePreset } from '../store/useFilterStore';
import { useAnalytics } from '../query/useAnalytics';
import { useAppStore } from '../store/useAppStore';
import { Button, Toggle, cx, formatDay } from './ui/primitives';

const PRESETS: Array<{ id: DatePreset; label: string }> = [
  { id: '7d', label: '7 j' },
  { id: '30d', label: '30 j' },
  { id: '3m', label: '3 m' },
  { id: '6m', label: '6 m' },
  { id: '12m', label: '12 m' },
  { id: '24m', label: '24 m' },
  { id: '36m', label: '36 m' },
  { id: 'all', label: 'Tout' },
];

export function FilterBar() {
  const { extent, namespaces, projectsById } = useAnalytics();
  const instances = useAppStore((state) => state.instances);
  const filters = useFilterStore();
  const [openPanel, setOpenPanel] = useState<'none' | 'dates' | 'groups'>('none');
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (openPanel === 'none') return;
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpenPanel('none');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenPanel('none');
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openPanel]);

  const selectedNamespaces = filters.namespaces;
  const rangeLabel =
    filters.from !== null || filters.to !== null
      ? `${filters.from ? formatDay(filters.from) : '…'} → ${filters.to ? formatDay(filters.to) : '…'}`
      : 'Toute la période';

  const toggleNamespace = (path: string) => {
    const next = new Set(selectedNamespaces ?? []);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    filters.setNamespaces(next.size === 0 ? null : next);
  };

  const activeCount =
    (filters.namespaces !== null ? 1 : 0) +
    (filters.projectKeys !== null ? 1 : 0) +
    (filters.instanceIds !== null ? 1 : 0) +
    (filters.authorIds !== null ? 1 : 0) +
    (filters.search !== '' ? 1 : 0);

  const toggleInstance = (id: string) => {
    const next = new Set(filters.instanceIds ?? instances.map((instance) => instance.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Tout coché revient à ne rien filtrer.
    filters.setInstanceIds(next.size === 0 || next.size === instances.length ? null : next);
  };

  return (
    <div
      ref={panelRef}
      className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--plane)_88%,transparent)] backdrop-blur"
    >
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-5 py-2.5">
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] p-0.5">
          {PRESETS.map((preset) => {
            const active = filters.preset === preset.id;
            // Un préréglage qui remonte plus loin que l'historique donne le même
            // graphe que « Tout ». Il reste cliquable — la fenêtre est rognée à
            // l'affichage — mais s'affiche en retrait pour que le lecteur
            // comprenne pourquoi rien ne bouge. Jamais sur le bouton actif : le
            // texte en retrait sur le fond accentué perdrait son contraste.
            const start = rangeForPreset(preset.id, extent).from;
            const beyondDataHint =
              !active && extent.from !== null && start !== null && start < extent.from
                ? `Données disponibles depuis le ${formatDay(extent.from)}`
                : undefined;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => filters.setPreset(preset.id, extent)}
                title={beyondDataHint}
                className={cx(
                  'h-7 cursor-pointer rounded-md px-1.5 text-xs font-medium transition',
                  active
                    ? 'bg-[var(--series-1)] text-white'
                    : cx(
                        'hover:bg-[var(--surface-2)]',
                        beyondDataHint !== undefined
                          ? 'text-[var(--text-muted)]'
                          : 'text-[var(--text-secondary)]',
                      ),
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="relative">
          <Button
            onClick={() => setOpenPanel(openPanel === 'dates' ? 'none' : 'dates')}
            aria-expanded={openPanel === 'dates'}
          >
            <span className="text-[var(--text-muted)]">Période</span>
            <span className="tnum">{rangeLabel}</span>
          </Button>
          {openPanel === 'dates' && (
            <div className="absolute top-9 left-0 z-40 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 shadow-2xl">
              <label className="block text-xs text-[var(--text-muted)]">
                Du
                <input
                  type="date"
                  value={filters.from ?? ''}
                  min={extent.from ?? undefined}
                  max={extent.to ?? undefined}
                  onChange={(event) => filters.setRange(event.target.value || null, filters.to)}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                />
              </label>
              <label className="mt-2 block text-xs text-[var(--text-muted)]">
                Au
                <input
                  type="date"
                  value={filters.to ?? ''}
                  min={extent.from ?? undefined}
                  max={extent.to ?? undefined}
                  onChange={(event) => filters.setRange(filters.from, event.target.value || null)}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                />
              </label>
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                Données disponibles du {extent.from ? formatDay(extent.from) : '—'} au{' '}
                {extent.to ? formatDay(extent.to) : '—'}.
              </p>
            </div>
          )}
        </div>

        {instances.length > 1 && (
          <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] p-0.5">
            {instances.map((instance) => {
              // Sans filtre explicite, toutes les instances sont actives.
              const active = filters.instanceIds === null || filters.instanceIds.has(instance.id);
              return (
                <button
                  key={instance.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleInstance(instance.id)}
                  title={instance.host}
                  className={cx(
                    'h-7 max-w-[160px] cursor-pointer truncate rounded-md px-2.5 text-xs font-medium transition',
                    active
                      ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)]',
                  )}
                >
                  {instance.label}
                </button>
              );
            })}
          </div>
        )}

        {namespaces.length > 0 && (
          <div className="relative">
            <Button
              onClick={() => setOpenPanel(openPanel === 'groups' ? 'none' : 'groups')}
              aria-expanded={openPanel === 'groups'}
            >
              Groupes
              {selectedNamespaces !== null && (
                <span className="rounded bg-[var(--series-1)] px-1.5 text-xs text-white">
                  {selectedNamespaces.size}
                </span>
              )}
            </Button>
            {openPanel === 'groups' && (
              <div className="absolute top-9 left-0 z-40 max-h-80 w-80 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2 shadow-2xl">
                <div className="flex items-center justify-between px-1 pb-1">
                  <span className="text-xs text-[var(--text-muted)]">Sélection inclusive des sous-groupes</span>
                  <button
                    type="button"
                    onClick={() => filters.setNamespaces(null)}
                    className="cursor-pointer text-xs text-[var(--series-1)] hover:underline"
                  >
                    Tout
                  </button>
                </div>
                {namespaces.map((namespace) => {
                  const depth = namespace.path.split('/').length - 1;
                  const checked = selectedNamespaces?.has(namespace.path) ?? false;
                  return (
                    <label
                      key={namespace.path}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-[var(--surface-1)]"
                      style={{ paddingLeft: 6 + depth * 14 }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleNamespace(namespace.path)}
                        className="accent-[var(--series-1)]"
                      />
                      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                        {namespace.path.split('/').pop()}
                      </span>
                      <span className="tnum text-xs text-[var(--text-muted)]">{namespace.count}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <input
          type="search"
          value={filters.search}
          onChange={(event) => filters.setSearch(event.target.value)}
          placeholder={`Filtrer ${projectsById.size} dépôts…`}
          className="h-8 min-w-[180px] flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
        />

        <div className="flex items-center gap-4">
          <Toggle checked={filters.excludeBots} onChange={filters.toggleBots} label="Masquer les bots" />
          <Toggle checked={filters.excludeMerges} onChange={filters.toggleMerges} label="Masquer les merges" />
          <Toggle
            checked={filters.excludeMuted}
            onChange={filters.toggleMuted}
            label="Masquer les dépôts ignorés"
          />
        </div>

        {(activeCount > 0 || filters.preset !== 'all') && (
          <Button variant="subtle" onClick={() => filters.reset(extent)}>
            Réinitialiser
          </Button>
        )}
      </div>
    </div>
  );
}
