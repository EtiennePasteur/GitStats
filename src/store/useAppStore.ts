/**
 * État applicatif (Zustand).
 *
 * Le Dataset est volumineux et muté en place par le moteur de sync. Plutôt que
 * de le recopier à chaque évènement (des milliers par sync), on le garde par
 * référence et on incrémente un compteur `dataVersion` : les sélecteurs React
 * s'abonnent à ce compteur, ce qui donne une invalidation explicite et bon marché.
 */

import { create } from 'zustand';
import { GitLabClient, normalizeHost } from '../gitlab/client';
import { RateLimiter } from '../gitlab/rateLimiter';
import { getCurrentUser } from '../gitlab/endpoints';
import { SyncCoordinator, type AggregateProgress } from '../sync/coordinator';
import { windowStart } from '../sync/planner';
import {
  DEFAULT_SYNC_CONFIG,
  instanceId as deriveInstanceId,
  type SyncConfig,
  type StoredMeta,
  type GitLabInstance,
} from '../model/types';
import {
  loadDataset,
  persistWholeDataset,
  emptyDataset,
  alignAuthorsToAliases,
  type Dataset,
} from './dataset';
import * as db from './db';
import { serializeDataset, deserializeDataset } from './serialize';
import { saveToLinkedFile, getLinkedFileName } from './fileHandle';

const TOKENS_KEY = 'gitstats.tokens';
const TOKEN_PERSIST_KEY = 'gitstats.token.persist';

export type AppStatus = 'booting' | 'onboarding' | 'ready' | 'unavailable';

/** Tokens en mémoire, indexés par instance. Jamais persistés en base ni exportés. */
export type TokenMap = Record<string, string>;

interface AppState {
  status: AppStatus;
  instances: GitLabInstance[];
  tokens: TokenMap;
  rememberTokens: boolean;
  config: SyncConfig;

  dataset: Dataset;
  /** Incrémenté à chaque mutation du Dataset — sert d'invalidation aux sélecteurs. */
  dataVersion: number;

  progress: AggregateProgress | null;
  coordinator: SyncCoordinator | null;
  isSyncing: boolean;
  linkedFileName: string | null;
  lastSaveError: string | null;
  /** Message d'un stockage local inutilisable — voir `boot`. */
  bootError: string | null;

  boot: () => Promise<void>;
  /** Valide le couple hôte/token puis ajoute l'instance. Renvoie l'instance créée. */
  addInstance: (host: string, token: string) => Promise<GitLabInstance>;
  removeInstance: (instanceId: string, wipeData: boolean) => Promise<void>;
  renameInstance: (instanceId: string, label: string) => Promise<void>;
  setRememberTokens: (remember: boolean) => void;
  disconnect: (wipeData: boolean) => Promise<void>;

  updateConfig: (patch: Partial<SyncConfig>) => Promise<void>;
  setProjectExcluded: (projectKey: string, excluded: boolean) => Promise<void>;
  setProjectMuted: (projectKey: string, muted: boolean) => Promise<void>;
  startSync: (overrides?: Partial<SyncConfig>) => Promise<void>;
  pauseSync: () => void;
  resumeSync: () => void;
  cancelSync: () => void;
  touchData: () => void;
  saveToFile: () => Promise<void>;
  importFromText: (text: string) => Promise<void>;
  refreshLinkedFileName: () => Promise<void>;
  setManualAliases: (aliases: Record<string, string>) => Promise<void>;
}

function readStoredTokens(): { tokens: TokenMap; remember: boolean } {
  if (typeof window === 'undefined') return { tokens: {}, remember: false };
  const remember = window.localStorage.getItem(TOKEN_PERSIST_KEY) === '1';
  const raw = (remember ? window.localStorage : window.sessionStorage).getItem(TOKENS_KEY);
  if (raw === null) return { tokens: {}, remember };
  try {
    const parsed: unknown = JSON.parse(raw);
    return {
      tokens: typeof parsed === 'object' && parsed !== null ? (parsed as TokenMap) : {},
      remember,
    };
  } catch {
    return { tokens: {}, remember };
  }
}

function storeTokens(tokens: TokenMap, remember: boolean): void {
  if (typeof window === 'undefined') return;
  // Les tokens ne descendent JAMAIS dans IndexedDB ni dans le fichier exporté.
  window.sessionStorage.removeItem(TOKENS_KEY);
  window.localStorage.removeItem(TOKENS_KEY);
  window.localStorage.setItem(TOKEN_PERSIST_KEY, remember ? '1' : '0');
  if (Object.keys(tokens).length === 0) return;
  (remember ? window.localStorage : window.sessionStorage).setItem(TOKENS_KEY, JSON.stringify(tokens));
}

function makeMeta(config: SyncConfig, instances: GitLabInstance[], previous: StoredMeta | null): StoredMeta {
  const now = new Date();
  return {
    instances,
    window: { from: windowStart(config, now), until: now.toISOString() },
    lastSyncAt: previous?.lastSyncAt ?? null,
    config,
    manualAliases: previous?.manualAliases ?? {},
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  status: 'booting',
  instances: [],
  tokens: {},
  rememberTokens: false,
  config: DEFAULT_SYNC_CONFIG,
  dataset: emptyDataset(),
  dataVersion: 0,
  progress: null,
  coordinator: null,
  isSyncing: false,
  linkedFileName: null,
  lastSaveError: null,
  bootError: null,

  async boot() {
    // IndexedDB peut refuser de s'ouvrir : navigation privée, quota épuisé, ou
    // base d'un schéma que cette version ne sait plus ouvrir. Sans ce filet,
    // l'application resterait sur son squelette de chargement sans rien dire.
    let dataset: Dataset;
    try {
      dataset = await loadDataset();
    } catch (caught) {
      set({
        status: 'unavailable',
        bootError: caught instanceof Error ? caught.message : String(caught),
      });
      return;
    }
    const config = dataset.meta?.config ?? DEFAULT_SYNC_CONFIG;
    const instances = dataset.meta?.instances ?? [];
    const { tokens, remember } = readStoredTokens();
    const linkedFileName = await getLinkedFileName().catch(() => null);

    set({
      dataset,
      dataVersion: get().dataVersion + 1,
      config: { ...config, forceFullResync: false },
      instances,
      tokens,
      rememberTokens: remember,
      linkedFileName,
      // Des données déjà présentes permettent de consulter les tableaux de bord
      // hors ligne, sans redemander de token.
      status: instances.length > 0 || dataset.projects.size > 0 ? 'ready' : 'onboarding',
    });
  },

  async addInstance(host, token) {
    // On valide AVANT d'enregistrer : découvrir un 401 au bout de 200 appels
    // serait pénible pour l'utilisateur comme pour GitLab.
    const limiter = new RateLimiter({ requestsPerMinute: 120, maxConcurrent: 2 });
    try {
      const normalizedHost = normalizeHost(host);
      const id = deriveInstanceId(normalizedHost);
      const client = new GitLabClient({ host: normalizedHost, token, limiter });
      const user = await getCurrentUser(client);

      const existing = get().instances.find((instance) => instance.id === id);
      const instance: GitLabInstance = {
        id,
        host: normalizedHost,
        // Un ré-ajout conserve le libellé personnalisé.
        label: existing?.label ?? normalizedHost.replace(/^https?:\/\//, ''),
        user: { id: user.id, username: user.username, name: user.name },
        addedAt: existing?.addedAt ?? new Date().toISOString(),
        authError: null,
      };

      const instances = existing
        ? get().instances.map((entry) => (entry.id === id ? instance : entry))
        : [...get().instances, instance];
      const tokens = { ...get().tokens, [id]: token };

      storeTokens(tokens, get().rememberTokens);
      const meta = makeMeta(get().config, instances, get().dataset.meta);
      await db.writeMeta(meta);
      get().dataset.meta = meta;

      set({ instances, tokens, status: 'ready' });
      return instance;
    } finally {
      limiter.dispose();
    }
  },

  async removeInstance(id, wipeData) {
    const instances = get().instances.filter((instance) => instance.id !== id);
    const tokens = { ...get().tokens };
    delete tokens[id];
    storeTokens(tokens, get().rememberTokens);

    const dataset = get().dataset;
    if (wipeData) {
      // Suppression ciblée : les autres instances gardent leurs données.
      for (const [key, project] of [...dataset.projects]) {
        if (project.instanceId !== id) continue;
        dataset.projects.delete(key);
        dataset.overviews.delete(key);
        await db.deleteDailyForProject(key);
      }
      for (const [key, bucket] of [...dataset.daily]) {
        if (bucket.projectKey.startsWith(`${id}~`)) dataset.daily.delete(key);
      }
      for (const [key, commit] of [...dataset.recentCommits]) {
        if (commit.projectKey.startsWith(`${id}~`)) dataset.recentCommits.delete(key);
      }
      await db.replaceRecentCommits([...dataset.recentCommits.values()]);
      await db.writeProjects([...dataset.projects.values()]);
    }

    const meta = makeMeta(get().config, instances, dataset.meta);
    await db.writeMeta(meta);
    dataset.meta = meta;

    set({
      instances,
      tokens,
      dataVersion: get().dataVersion + 1,
      status: instances.length === 0 && dataset.projects.size === 0 ? 'onboarding' : 'ready',
    });
  },

  async renameInstance(id, label) {
    const instances = get().instances.map((instance) =>
      instance.id === id ? { ...instance, label } : instance,
    );
    const meta = makeMeta(get().config, instances, get().dataset.meta);
    await db.writeMeta(meta);
    get().dataset.meta = meta;
    set({ instances, dataVersion: get().dataVersion + 1 });
  },

  setRememberTokens(remember) {
    storeTokens(get().tokens, remember);
    set({ rememberTokens: remember });
  },

  async disconnect(wipeData) {
    get().coordinator?.cancel();
    storeTokens({}, false);
    if (wipeData) {
      await db.clearAllData(false);
      set({ dataset: emptyDataset(), dataVersion: get().dataVersion + 1, instances: [] });
    }
    set({ tokens: {}, status: 'onboarding', progress: null, coordinator: null, isSyncing: false });
  },

  async updateConfig(patch) {
    const config = { ...get().config, ...patch };
    const meta = makeMeta(config, get().instances, get().dataset.meta);
    await db.writeMeta(meta);
    get().dataset.meta = meta;
    set({ config });
  },

  async setProjectExcluded(projectKey, excluded) {
    const project = get().dataset.projects.get(projectKey);
    if (project === undefined) return;
    project.excluded = excluded || undefined;
    await db.writeProject(project);
    get().touchData();
  },

  async setProjectMuted(projectKey, muted) {
    const project = get().dataset.projects.get(projectKey);
    if (project === undefined) return;
    // `undefined` plutôt que `false` : un dépôt jamais ignoré ne porte pas le champ.
    project.muted = muted || undefined;
    await db.writeProject(project);
    get().touchData();
  },

  async startSync(overrides) {
    const { tokens, config: baseConfig, dataset, isSyncing, instances } = get();
    if (isSyncing) return;

    const targets = instances
      .filter((instance) => typeof tokens[instance.id] === 'string' && tokens[instance.id] !== '')
      .map((instance) => ({ instance, token: tokens[instance.id]! }));

    if (targets.length === 0) {
      set({ status: 'onboarding' });
      return;
    }

    const config: SyncConfig = { ...baseConfig, ...overrides };
    const coordinator = new SyncCoordinator({
      targets,
      config,
      dataset,
      onProgress: (progress) => set({ progress }),
      onDataChanged: () => get().touchData(),
      onCheckpoint: async () => {
        const result = await saveToLinkedFile(serializeDataset(get().dataset));
        if (!result.saved && result.reason === 'error') {
          set({ lastSaveError: result.error ?? 'Échec de la sauvegarde fichier.' });
        }
      },
    });

    set({ coordinator, isSyncing: true, lastSaveError: null });
    try {
      await coordinator.run();
    } finally {
      const meta = makeMeta({ ...config, forceFullResync: false }, get().instances, dataset.meta);
      meta.lastSyncAt = new Date().toISOString();
      await db.writeMeta(meta);
      dataset.meta = meta;
      coordinator.dispose();
      set({
        isSyncing: false,
        coordinator: null,
        config: { ...config, forceFullResync: false },
        // Les erreurs d'authentification remontées par le coordinateur sont
        // portées par les instances : on rafraîchit la copie du store.
        instances: [...get().instances],
      });
      get().touchData();
      await get().refreshLinkedFileName();
    }
  },

  pauseSync() {
    get().coordinator?.pause();
  },
  resumeSync() {
    get().coordinator?.resume();
  },
  cancelSync() {
    get().coordinator?.cancel();
  },

  touchData() {
    set({ dataVersion: get().dataVersion + 1 });
  },

  async saveToFile() {
    const result = await saveToLinkedFile(serializeDataset(get().dataset));
    set({ lastSaveError: result.saved ? null : (result.error ?? null) });
    await get().refreshLinkedFileName();
  },

  async importFromText(text) {
    const parsed: unknown = JSON.parse(text);
    const dataset = deserializeDataset(parsed);
    await persistWholeDataset(dataset);
    const instances = dataset.meta?.instances ?? [];
    set({
      dataset,
      dataVersion: get().dataVersion + 1,
      config: dataset.meta?.config ?? DEFAULT_SYNC_CONFIG,
      instances,
      status: 'ready',
    });
  },

  async refreshLinkedFileName() {
    set({ linkedFileName: await getLinkedFileName().catch(() => null) });
  },

  async setManualAliases(aliases) {
    const dataset = get().dataset;
    const meta = makeMeta(get().config, get().instances, dataset.meta);
    meta.manualAliases = aliases;
    await db.writeMeta(meta);
    dataset.meta = meta;

    // Appliquer une fusion se résout à la lecture, mais l'ANNULER doit défaire ce
    // qu'un sync avait matérialisé dans les fiches : sans ce réalignement, la
    // personne garderait ses deux adresses et l'alias serait rétabli d'office au
    // prochain chargement (`recoverManualAliases`).
    const detached = alignAuthorsToAliases(dataset);
    if (detached.length > 0) await db.writeAuthors([...dataset.authors.values()]);

    get().touchData();
  },
}));
