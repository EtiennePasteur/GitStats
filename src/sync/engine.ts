/**
 * Orchestrateur du sync, en trois vagues.
 *
 *  Vague 0 — Découverte      ~3 appels    : liste des projets (+ `last_activity_at`)
 *  Vague 1 — Aperçu          1 appel/projet : classement global exploitable en ~40 s
 *  Vague 2 — Timeline        N appels/projet : historique daté, incrémental ensuite
 *
 * Les vagues 1 et 2 sont séparées volontairement : traiter chaque projet de bout
 * en bout ferait attendre le classement global le temps du dépôt le plus lourd,
 * alors qu'un balayage complet des aperçus le rend disponible en moins d'une minute.
 *
 * Aucun import React : ce module doit rester déplaçable dans un Web Worker.
 */

import type { GitLabClient } from '../gitlab/client';
import type { RateLimiter, RateLimiterStats } from '../gitlab/rateLimiter';
import { AbortError } from '../gitlab/rateLimiter';
import { iterateProjects, getContributors, iterateCommits } from '../gitlab/endpoints';
import { GitLabNotFoundError, GitLabForbiddenError, isFatalAuthError } from '../gitlab/errors';
import type { GitLabProjectSimple } from '../gitlab/types';
import {
  collectionFingerprint,
  projectKey as makeProjectKey,
  type StoredProject,
  type ProjectSyncState,
  type SyncConfig,
  type ProjectOverview,
  type ProjectKey,
  type GitLabInstance,
} from '../model/types';
import { IdentityResolver, identityKey } from './identity';
import { ingestCommits, trimRecentShas } from './aggregate';
import { planSync, windowStart, type ProjectPlan } from './planner';
import type { Dataset } from '../store/dataset';
import { mergeBucketsInMemory, mergeRhythmsInMemory, resetProjectInMemory } from '../store/dataset';
import * as db from '../store/db';

export type SyncPhase =
  | 'idle'
  | 'discovering'
  | 'overview'
  | 'commits'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'error';

export interface ProjectProgress {
  key: ProjectKey;
  instanceId: string;
  name: string;
  pathWithNamespace: string;
  state: ProjectSyncState;
  currentPage: number;
  commitsIngested: number;
  error: string | null;
}

export interface SyncProgress {
  phase: SyncPhase;
  message: string;
  projectsTotal: number;
  projectsPlanned: number;
  projectsSkipped: number;
  projectsDone: number;
  projectsError: number;
  overviewsDone: number;
  overviewsPlanned: number;
  commitsIngested: number;
  requestsMade: number;
  startedAt: number | null;
  elapsedMs: number;
  /** `null` tant que l'estimation n'est pas fiable. */
  etaMs: number | null;
  rate: RateLimiterStats;
  projects: ProjectProgress[];
  fatalError: string | null;
}

export interface SyncEngineOptions {
  /** Instance traitée par ce moteur. Un moteur = une instance. */
  instance: GitLabInstance;
  client: GitLabClient;
  limiter: RateLimiter;
  config: SyncConfig;
  dataset: Dataset;
  /**
   * Résolveur d'identités PARTAGÉ entre toutes les instances.
   *
   * Il est injecté et non construit ici : c'est lui qui permet à une même
   * personne présente sur deux serveurs d'être agrégée en une seule entrée.
   * Avec un résolveur par moteur, chacun produirait sa propre table d'auteurs.
   */
  resolver: IdentityResolver;
  /** Signale au coordinateur que les auteurs ont bougé — c'est LUI qui les persiste. */
  onAuthorsChanged: () => void | Promise<void>;
  /** Appelé au maximum ~10×/s. */
  onProgress: (progress: SyncProgress) => void;
  /** Appelé quand le Dataset a changé et que l'UI doit se rafraîchir. */
  onDataChanged: () => void;
  /** Sauvegarde du fichier .json lié, appelée périodiquement. */
  onCheckpoint?: () => void | Promise<void>;
  now?: () => Date;
}

const PROGRESS_INTERVAL_MS = 120;
const CHECKPOINT_EVERY_PROJECTS = 10;

export class SyncEngine {
  private readonly options: SyncEngineOptions;
  private readonly controller = new AbortController();
  private readonly resolver: IdentityResolver;

  private phase: SyncPhase = 'idle';
  private message = '';
  private fatalError: string | null = null;

  private projectsTotal = 0;
  private projectsPlanned = 0;
  private projectsSkipped = 0;
  private projectsDone = 0;
  private projectsError = 0;
  private overviewsDone = 0;
  private overviewsPlanned = 0;
  private commitsIngested = 0;
  private requestsMade = 0;
  private startedAt: number | null = null;
  private completedSinceStart = 0;

  private readonly progressById = new Map<ProjectKey, ProjectProgress>();
  private lastEmitAt = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  private pauseGate: Promise<void> | null = null;
  private releasePause: (() => void) | null = null;
  private projectsSinceCheckpoint = 0;

  constructor(options: SyncEngineOptions) {
    this.options = options;
    this.resolver = options.resolver;
  }

  get instanceId(): string {
    return this.options.instance.id;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    this.resume();
    this.controller.abort();
  }

  pause(): void {
    if (this.pauseGate !== null) return;
    this.pauseGate = new Promise<void>((resolve) => {
      this.releasePause = resolve;
    });
    this.setPhase('paused', 'En pause');
  }

  resume(): void {
    if (this.releasePause === null) return;
    this.releasePause();
    this.releasePause = null;
    this.pauseGate = null;
  }

  get isPaused(): boolean {
    return this.pauseGate !== null;
  }

  /** Point d'attente coopératif, appelé entre chaque requête. */
  private async gate(): Promise<void> {
    if (this.controller.signal.aborted) throw new AbortError();
    if (this.pauseGate !== null) await this.pauseGate;
    if (this.controller.signal.aborted) throw new AbortError();
  }

  async run(): Promise<void> {
    this.startedAt = Date.now();
    try {
      const remoteProjects = await this.discover();
      const now = this.options.now?.() ?? new Date();
      // Restriction aux projets de CETTE instance : sans ce filtre, le projet 42
      // d'un autre serveur serait pris pour celui-ci et déclaré « inchangé ».
      const mine = new Map<ProjectKey, StoredProject>();
      for (const [key, project] of this.options.dataset.projects) {
        if (project.instanceId === this.instanceId) mine.set(key, project);
      }
      const summary = planSync(remoteProjects, mine, this.options.config, now, this.instanceId);

      this.projectsPlanned = summary.toSync;
      this.projectsSkipped = summary.skipped;
      this.overviewsPlanned = summary.plans.filter((plan) => plan.needsOverview).length;

      const active = summary.plans.filter((plan) => plan.shouldSync);
      for (const plan of summary.plans) {
        if (!plan.shouldSync) {
          this.markState(plan.projectKey, 'skipped');
          await this.persistSkipped(plan.projectKey, now);
        }
      }
      this.emit(true);

      // Vague 1 : tous les aperçus d'abord, pour un classement global immédiat.
      const needOverview = active.filter((plan) => plan.needsOverview);
      if (needOverview.length > 0) {
        this.setPhase('overview', `Aperçu de ${needOverview.length} dépôts…`);
        await this.pool(needOverview, (plan) => this.runOverview(plan));
      }

      // Vague 2 : historique daté.
      this.setPhase('commits', `Historique de ${active.length} dépôts…`);
      await this.pool(active, (plan) => this.runCommits(plan, now));

      await this.finalizeAuthors();
      await this.checkpoint(true);
      this.setPhase('done', this.buildSummaryMessage());
    } catch (error) {
      if (this.controller.signal.aborted || error instanceof AbortError) {
        await this.finalizeAuthors();
        await this.checkpoint(true);
        this.setPhase('cancelled', 'Sync interrompu — les données déjà collectées sont conservées.');
        return;
      }
      this.fatalError = error instanceof Error ? error.message : String(error);
      if (isFatalAuthError(error)) {
        this.fatalError = 'Token GitLab invalide ou expiré. Reconnectez-vous.';
      }
      this.setPhase('error', this.fatalError);
      throw error;
    } finally {
      this.emit(true);
    }
  }

  // --- vague 0 --------------------------------------------------------

  private async discover(): Promise<GitLabProjectSimple[]> {
    this.setPhase('discovering', 'Recherche des dépôts accessibles…');
    const { client, config } = this.options;
    const projects: GitLabProjectSimple[] = [];

    for await (const page of iterateProjects(
      client,
      {
        membership: config.membership,
        includeArchived: config.includeArchived,
      },
      this.controller.signal,
    )) {
      await this.gate();
      this.requestsMade += 1;
      projects.push(...page.items);
      this.projectsTotal = page.total ?? projects.length;
      // `X-Total` est exposé par CORS : la progression est exacte dès la 1ʳᵉ page.
      this.message = `Recherche des dépôts… ${projects.length}${page.total ? ` / ${page.total}` : ''}`;
      this.emit();
    }

    this.projectsTotal = projects.length;
    const mine: StoredProject[] = [];
    for (const project of projects) {
      const key = makeProjectKey(this.instanceId, project.id);
      const stored = this.options.dataset.projects.get(key);
      this.progressById.set(key, {
        key,
        instanceId: this.instanceId,
        name: project.name,
        pathWithNamespace: project.path_with_namespace,
        state: 'pending',
        currentPage: 0,
        commitsIngested: 0,
        error: stored?.sync.error ?? null,
      });
      const next = this.toStoredProject(key, project, stored);
      this.options.dataset.projects.set(key, next);
      mine.push(next);
    }
    // On n'écrit QUE ses propres projets : les autres instances gèrent les leurs.
    await db.writeProjects(mine);
    this.options.onDataChanged();
    this.emit(true);
    return projects;
  }

  private toStoredProject(
    key: ProjectKey,
    remote: GitLabProjectSimple,
    previous: StoredProject | undefined,
  ): StoredProject {
    return {
      key,
      gitlabId: remote.id,
      instanceId: this.instanceId,
      name: remote.name,
      nameWithNamespace: remote.name_with_namespace,
      pathWithNamespace: remote.path_with_namespace,
      namespaceFullPath: remote.namespace.full_path,
      defaultBranch: remote.default_branch,
      webUrl: remote.web_url,
      avatarUrl: remote.avatar_url,
      createdAt: remote.created_at,
      archived: remote.archived ?? false,
      lastActivityAt: remote.last_activity_at,
      excluded: previous?.excluded,
      // Décisions de l'utilisateur : elles doivent survivre à chaque re-découverte
      // du dépôt, sinon un sync les efface en silence.
      muted: previous?.muted,
      sync: previous?.sync ?? {
        state: 'pending',
        coveredFrom: null,
        coveredUntil: null,
        syncedActivityAt: null,
        lastSyncedAt: null,
        commitCount: 0,
        recentShas: [],
        hasOverview: false,
        error: null,
        currentPage: 0,
        fingerprint: collectionFingerprint(this.options.config),
      },
    };
  }

  // --- vague 1 --------------------------------------------------------

  private async runOverview(plan: ProjectPlan): Promise<void> {
    await this.gate();
    const project = this.options.dataset.projects.get(plan.projectKey);
    if (!project) return;

    this.markState(plan.projectKey, 'overview');
    try {
      const contributors = await getContributors(
        this.options.client,
        // L'API attend l'identifiant numérique de l'instance, pas notre clé interne.
        project.gitlabId,
        project.defaultBranch,
        this.controller.signal,
      );
      this.requestsMade += 1;

      if (contributors === null) {
        this.markState(plan.projectKey, 'empty');
        project.sync.state = 'empty';
        return;
      }

      const overview: ProjectOverview = {
        projectKey: project.key,
        fetchedAt: new Date().toISOString(),
        entries: contributors.map((contributor) => ({
          authorId: this.resolver.observe(
            { name: contributor.name, email: contributor.email },
            // Le poids sert à élire le nom d'affichage : on prend le vrai volume.
            contributor.commits,
          ),
          commits: contributor.commits,
          additions: contributor.additions,
          deletions: contributor.deletions,
        })),
      };
      this.options.dataset.overviews.set(project.key, overview);
      project.sync.hasOverview = true;
      await db.writeOverview(overview);

      this.overviewsDone += 1;
      this.options.onDataChanged();
    } catch (error) {
      if (this.isAbort(error)) throw error;
      if (error instanceof GitLabNotFoundError || error instanceof GitLabForbiddenError) {
        this.markState(plan.projectKey, 'empty');
        return;
      }
      // Un aperçu manquant n'est pas bloquant : la vague 2 fournira les vraies données.
      this.setProjectError(plan.projectKey, error, /* fatal */ false);
    } finally {
      this.emit();
    }
  }

  // --- vague 2 --------------------------------------------------------

  private async runCommits(plan: ProjectPlan, now: Date): Promise<void> {
    await this.gate();
    const project = this.options.dataset.projects.get(plan.projectKey);
    if (!project) return;

    const { config, dataset } = this.options;

    if (plan.resetExisting) {
      resetProjectInMemory(dataset, project.key);
      await db.deleteDailyForProject(project.key);
      project.sync.commitCount = 0;
      project.sync.recentShas = [];
      project.sync.coveredFrom = null;
      project.sync.coveredUntil = null;
    }

    this.markState(plan.projectKey, 'commits');
    const knownShas = new Set(project.sync.recentShas);
    const allRecent: Array<{ sha: string; date: string }> = [];
    let ingestedForProject = 0;
    let oldest: string | null = project.sync.coveredFrom;
    let newest: string | null = project.sync.coveredUntil;

    try {
      for (const range of plan.ranges) {
        let page = 0;
        for await (const chunk of iterateCommits(
          this.options.client,
          project.gitlabId,
          {
            since: range.since ?? undefined,
            until: range.until,
            refName: project.defaultBranch,
            allBranches: config.allBranches,
            withStats: config.withStats,
          },
          this.controller.signal,
        )) {
          await this.gate();
          this.requestsMade += 1;
          page += 1;
          this.updateProgress(plan.projectKey, (entry) => {
            entry.currentPage = page;
          });

          const result = ingestCommits(project.key, chunk.items, this.resolver, knownShas);
          for (const sha of result.ingestedShas) knownShas.add(sha);

          mergeBucketsInMemory(dataset, result.buckets);
          mergeRhythmsInMemory(dataset, result.rhythms);
          for (const commit of result.recentCommits) {
            dataset.recentCommits.set(commit.key, commit);
            allRecent.push({ sha: commit.sha, date: commit.date });
          }

          await db.mergeDaily(result.buckets);
          await db.mergeRhythms(result.rhythms);
          if (result.recentCommits.length > 0) {
            await db.writeRecentCommits(project.key, result.recentCommits);
          }

          ingestedForProject += result.ingestedCount;
          this.commitsIngested += result.ingestedCount;
          this.updateProgress(plan.projectKey, (entry) => {
            entry.commitsIngested += result.ingestedCount;
          });

          if (result.oldestCommittedDate !== null) {
            oldest = oldest === null || result.oldestCommittedDate < oldest ? result.oldestCommittedDate : oldest;
          }
          if (result.newestCommittedDate !== null) {
            newest = newest === null || result.newestCommittedDate > newest ? result.newestCommittedDate : newest;
          }

          this.options.onDataChanged();
          this.emit();
        }

        // La borne de couverture doit refléter la plage DEMANDÉE, pas les commits
        // trouvés : un dépôt sans activité récente n'en est pas moins couvert.
        if (range.since === null) oldest = null;
        else if (oldest === null || range.since < oldest) oldest = range.since;
        if (newest === null || range.until > newest) newest = range.until;
      }

      project.sync.state = ingestedForProject === 0 && project.sync.commitCount === 0 ? 'empty' : 'done';
      project.sync.coveredFrom = plan.ranges.some((r) => r.since === null) ? null : oldest;
      project.sync.coveredUntil = newest;
      project.sync.syncedActivityAt = project.lastActivityAt;
      project.sync.lastSyncedAt = now.toISOString();
      project.sync.commitCount += ingestedForProject;
      project.sync.recentShas = trimRecentShas(
        [
          ...allRecent,
          ...project.sync.recentShas.map((sha) => ({ sha, date: newest ?? now.toISOString() })),
        ],
        now,
      );
      project.sync.error = null;
      project.sync.fingerprint = collectionFingerprint(config);
      this.markState(plan.projectKey, project.sync.state);
      this.projectsDone += 1;
      this.completedSinceStart += 1;
    } catch (error) {
      if (this.isAbort(error)) {
        await db.writeProject(project);
        throw error;
      }
      // Dépôt vide ou sans droit de lecture du code : ce n'est pas une anomalie,
      // c'est un état normal du parc. Le compter en erreur ferait paniquer sur
      // un écran de sync par ailleurs sain.
      if (error instanceof GitLabNotFoundError || error instanceof GitLabForbiddenError) {
        project.sync.state = 'empty';
        project.sync.error = null;
        project.sync.syncedActivityAt = project.lastActivityAt;
        project.sync.lastSyncedAt = now.toISOString();
        project.sync.fingerprint = collectionFingerprint(config);
        // On marque la fenêtre comme couverte : sans cela le planner le
        // considérerait « jamais vu » et le redemanderait à chaque sync.
        project.sync.coveredFrom = plan.ranges[0]?.since ?? null;
        project.sync.coveredUntil = plan.ranges[plan.ranges.length - 1]?.until ?? now.toISOString();
        this.markState(plan.projectKey, 'empty');
        this.completedSinceStart += 1;
        return;
      }
      this.setProjectError(plan.projectKey, error, true);
      project.sync.state = 'error';
      project.sync.error = error instanceof Error ? error.message : String(error);
      this.projectsError += 1;
      this.completedSinceStart += 1;
      if (isFatalAuthError(error)) throw error;
    } finally {
      await db.writeProject(project);
      this.projectsSinceCheckpoint += 1;
      if (this.projectsSinceCheckpoint >= CHECKPOINT_EVERY_PROJECTS) {
        this.projectsSinceCheckpoint = 0;
        await this.finalizeAuthors();
        await this.checkpoint(false);
      }
      this.emit();
    }
  }

  // --- utilitaires ----------------------------------------------------

  /**
   * Pool de N projets traités en parallèle. Le limiteur régule le débit global ;
   * ce pool ne fait que borner le nombre de pipelines simultanés.
   */
  private async pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    const size = Math.min(this.options.config.maxConcurrent, Math.max(1, items.length));
    let cursor = 0;
    const runners = Array.from({ length: size }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item === undefined) return;
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  private isAbort(error: unknown): boolean {
    return this.controller.signal.aborted || error instanceof AbortError;
  }

  private async persistSkipped(key: ProjectKey, now: Date): Promise<void> {
    const project = this.options.dataset.projects.get(key);
    if (!project) return;
    project.sync.state = 'skipped';
    project.sync.lastSyncedAt = now.toISOString();
    await db.writeProject(project);
  }

  /**
   * Délègue au coordinateur : c'est lui qui possède le résolveur partagé et qui
   * écrit la table des auteurs. Si chaque moteur appelait `replaceAuthors`, le
   * second effacerait les personnes découvertes par le premier.
   */
  private async finalizeAuthors(): Promise<void> {
    await this.options.onAuthorsChanged();
  }

  private async checkpoint(force: boolean): Promise<void> {
    if (!this.options.onCheckpoint) return;
    if (!force && this.controller.signal.aborted) return;
    try {
      await this.options.onCheckpoint();
    } catch {
      // Une sauvegarde fichier ratée ne doit jamais interrompre le sync :
      // IndexedDB reste la source durable.
    }
  }

  private markState(key: ProjectKey, state: ProjectSyncState): void {
    this.updateProgress(key, (entry) => {
      entry.state = state;
    });
  }

  private setProjectError(key: ProjectKey, error: unknown, _fatal: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    this.updateProgress(key, (entry) => {
      entry.state = 'error';
      entry.error = message;
    });
  }

  private updateProgress(key: ProjectKey, mutate: (entry: ProjectProgress) => void): void {
    const entry = this.progressById.get(key);
    if (entry) mutate(entry);
  }

  private setPhase(phase: SyncPhase, message: string): void {
    this.phase = phase;
    this.message = message;
    this.emit(true);
  }

  private buildSummaryMessage(): string {
    const parts = [`${this.projectsDone} dépôts synchronisés`];
    if (this.projectsSkipped > 0) parts.push(`${this.projectsSkipped} inchangés ignorés`);
    if (this.projectsError > 0) parts.push(`${this.projectsError} en erreur`);
    parts.push(`${this.commitsIngested.toLocaleString('fr-FR')} commits`);
    parts.push(`${this.requestsMade.toLocaleString('fr-FR')} appels API`);
    return parts.join(' · ');
  }

  private estimateEta(): number | null {
    if (this.startedAt === null || this.completedSinceStart < 5) return null;
    const remaining = this.projectsPlanned - this.completedSinceStart;
    if (remaining <= 0) return 0;
    const perProject = (Date.now() - this.startedAt) / this.completedSinceStart;
    return Math.round(perProject * remaining);
  }

  /**
   * Émission throttlée. Le sync génère des milliers d'évènements : les relayer
   * tous ferait rendre React en boucle et saccader l'écran de chargement.
   */
  private emit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmitAt < PROGRESS_INTERVAL_MS) {
      if (this.emitTimer === null) {
        this.emitTimer = setTimeout(() => {
          this.emitTimer = null;
          this.emit(true);
        }, PROGRESS_INTERVAL_MS);
      }
      return;
    }
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.lastEmitAt = now;

    this.options.onProgress({
      phase: this.isPaused ? 'paused' : this.phase,
      message: this.message,
      projectsTotal: this.projectsTotal,
      projectsPlanned: this.projectsPlanned,
      projectsSkipped: this.projectsSkipped,
      projectsDone: this.projectsDone,
      projectsError: this.projectsError,
      overviewsDone: this.overviewsDone,
      overviewsPlanned: this.overviewsPlanned,
      commitsIngested: this.commitsIngested,
      requestsMade: this.requestsMade,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt === null ? 0 : now - this.startedAt,
      etaMs: this.estimateEta(),
      rate: this.options.limiter.stats(),
      projects: [...this.progressById.values()],
      fatalError: this.fatalError,
    });
  }
}

/** Fenêtre effectivement demandée, pour l'afficher et la stocker dans meta. */
export function describeWindow(config: SyncConfig, now: Date): { from: string | null; until: string } {
  return { from: windowStart(config, now), until: now.toISOString() };
}

export { identityKey };
