/**
 * Coordination du sync sur plusieurs instances GitLab.
 *
 * Le `SyncEngine` reste le travailleur d'UNE instance. Le coordinateur porte ce
 * qui doit impérativement être commun :
 *
 *  - **le résolveur d'identités**, partagé. C'est lui qui fait qu'une personne
 *    présente sur deux serveurs avec la même adresse ne compte que pour une.
 *    Un résolveur par moteur produirait deux tables d'auteurs disjointes ;
 *  - **l'écriture de la table des auteurs**, centralisée. `replaceAuthors()`
 *    remplace TOUT le magasin : si chaque moteur l'appelait, le second effacerait
 *    les personnes découvertes par le premier ;
 *  - **la sauvegarde du fichier `.json`**, qui doit refléter l'ensemble.
 *
 * Chaque instance reçoit en revanche son propre limiteur de débit : les quotas
 * sont propres à chaque serveur, un 429 sur l'un ne doit pas brider les autres.
 *
 * Aucun import React : ce module doit rester déplaçable dans un Web Worker.
 */

import { GitLabClient } from '../gitlab/client';
import { RateLimiter, type RateLimiterStats } from '../gitlab/rateLimiter';
import { isFatalAuthError } from '../gitlab/errors';
import type { GitLabInstance, SyncConfig } from '../model/types';
import { IdentityResolver } from './identity';
import { SyncEngine, type SyncProgress, type SyncPhase, type ProjectProgress } from './engine';
import type { Dataset } from '../store/dataset';
import * as db from '../store/db';

export interface InstanceProgress {
  instanceId: string;
  label: string;
  phase: SyncPhase;
  message: string;
  projectsTotal: number;
  projectsPlanned: number;
  projectsDone: number;
  projectsSkipped: number;
  projectsError: number;
  commitsIngested: number;
  requestsMade: number;
  rate: RateLimiterStats;
  /** Erreur bloquante propre à cette instance (token expiré, réseau…). */
  error: string | null;
}

/** Progression cumulée, plus le détail par instance. */
export interface AggregateProgress extends SyncProgress {
  instances: InstanceProgress[];
}

export interface SyncCoordinatorOptions {
  /** Instances à synchroniser, avec leur token respectif. */
  targets: Array<{
    instance: GitLabInstance;
    token: string;
    /** Injectable pour les tests : permet de simuler plusieurs serveurs. */
    fetchImpl?: typeof fetch;
    /** Réglages de reprise. Injectables pour ne pas attendre le vrai backoff en test. */
    retry?: { maxAttempts?: number; baseMs?: number; maxMs?: number };
  }>;
  config: SyncConfig;
  dataset: Dataset;
  onProgress: (progress: AggregateProgress) => void;
  onDataChanged: () => void;
  onCheckpoint?: () => void | Promise<void>;
  now?: () => Date;
}

const EMPTY_RATE: RateLimiterStats = {
  currentRpm: 0,
  targetRpm: 0,
  observedRpm: 0,
  active: 0,
  queued: 0,
  throttled: false,
  penalties: 0,
};

interface Runtime {
  instance: GitLabInstance;
  engine: SyncEngine;
  limiter: RateLimiter;
  progress: SyncProgress | null;
  error: string | null;
}

export class SyncCoordinator {
  private readonly options: SyncCoordinatorOptions;
  private readonly resolver: IdentityResolver;
  private readonly runtimes: Runtime[] = [];
  private authorsDirty = false;

  constructor(options: SyncCoordinatorOptions) {
    this.options = options;

    // Le résolveur est réamorcé avec les identités déjà connues pour que les
    // fusions (manuelles comprises) survivent à un rechargement de page.
    this.resolver = new IdentityResolver(options.dataset.meta?.manualAliases ?? {});
    for (const author of options.dataset.authors.values()) {
      for (const key of author.identityKeys) {
        if (key !== author.id) this.resolver.union(key, author.id, author.id);
      }
    }

    for (const { instance, token, fetchImpl, retry } of options.targets) {
      // Un limiteur PAR instance : les quotas sont propres à chaque serveur.
      const limiter = new RateLimiter({
        requestsPerMinute: options.config.requestsPerMinute,
        // `with_stats` fait calculer un diff par commit côté serveur : on réduit
        // la pression quand il est actif.
        maxConcurrent: options.config.withStats
          ? Math.max(2, Math.floor(options.config.maxConcurrent / 2))
          : options.config.maxConcurrent,
      });
      const client = new GitLabClient({
        host: instance.host,
        token,
        limiter,
        fetchImpl,
        maxAttempts: retry?.maxAttempts,
        retryBaseMs: retry?.baseMs,
        retryMaxMs: retry?.maxMs,
      });

      const runtime: Runtime = { instance, limiter, progress: null, error: null, engine: null as never };
      runtime.engine = new SyncEngine({
        instance,
        client,
        limiter,
        config: options.config,
        dataset: options.dataset,
        resolver: this.resolver,
        onAuthorsChanged: () => this.flushAuthors(),
        onProgress: (progress) => {
          runtime.progress = progress;
          this.emit();
        },
        onDataChanged: options.onDataChanged,
        onCheckpoint: options.onCheckpoint,
        now: options.now,
      });
      this.runtimes.push(runtime);
    }
  }

  pause(): void {
    for (const runtime of this.runtimes) runtime.engine.pause();
  }
  resume(): void {
    for (const runtime of this.runtimes) runtime.engine.resume();
  }
  cancel(): void {
    for (const runtime of this.runtimes) runtime.engine.cancel();
  }
  get isPaused(): boolean {
    return this.runtimes.some((runtime) => runtime.engine.isPaused);
  }

  async run(): Promise<void> {
    try {
      // Instances traitées en parallèle : ce sont des serveurs indépendants.
      // Un échec sur l'une ne doit pas priver l'utilisateur des autres, d'où le
      // `catch` par instance plutôt qu'un `Promise.all` qui rejetterait en bloc.
      await Promise.all(
        this.runtimes.map(async (runtime) => {
          try {
            await runtime.engine.run();
          } catch (error) {
            runtime.error = isFatalAuthError(error)
              ? `Token invalide ou expiré pour « ${runtime.instance.label} ».`
              : error instanceof Error
                ? error.message
                : String(error);
            // Mémorisé sur l'instance pour que les réglages proposent de la reconnecter.
            runtime.instance.authError = isFatalAuthError(error) ? runtime.error : null;
          }
        }),
      );
    } finally {
      await this.flushAuthors(true);
      this.emit(true);
    }
  }

  /**
   * Écrit la table des auteurs, une seule fois pour toutes les instances.
   * Sérialisé par un drapeau : plusieurs moteurs peuvent le demander en même
   * temps, il serait inutile de réécrire le magasin autant de fois.
   */
  private async flushAuthors(force = false): Promise<void> {
    if (this.authorsDirty && !force) return;
    this.authorsDirty = true;
    try {
      const manualAliases = this.options.dataset.meta?.manualAliases ?? {};
      const authors = this.resolver.toAuthors(this.options.config.botPatterns, manualAliases);
      this.options.dataset.authors = new Map(authors.map((author) => [author.id, author]));
      await db.replaceAuthors(authors);
      this.options.onDataChanged();
    } finally {
      this.authorsDirty = false;
    }
  }

  dispose(): void {
    for (const runtime of this.runtimes) runtime.limiter.dispose();
  }

  private emit(force = false): void {
    this.options.onProgress(this.aggregate());
    void force;
  }

  /** Somme des compteurs, et phase la moins avancée (celle qui reste à finir). */
  private aggregate(): AggregateProgress {
    const instances: InstanceProgress[] = this.runtimes.map((runtime) => ({
      instanceId: runtime.instance.id,
      label: runtime.instance.label,
      phase: runtime.error !== null ? 'error' : (runtime.progress?.phase ?? 'idle'),
      message: runtime.progress?.message ?? '',
      projectsTotal: runtime.progress?.projectsTotal ?? 0,
      projectsPlanned: runtime.progress?.projectsPlanned ?? 0,
      projectsDone: runtime.progress?.projectsDone ?? 0,
      projectsSkipped: runtime.progress?.projectsSkipped ?? 0,
      projectsError: runtime.progress?.projectsError ?? 0,
      commitsIngested: runtime.progress?.commitsIngested ?? 0,
      requestsMade: runtime.progress?.requestsMade ?? 0,
      rate: runtime.progress?.rate ?? EMPTY_RATE,
      error: runtime.error,
    }));

    const sum = (pick: (p: SyncProgress) => number): number =>
      this.runtimes.reduce((total, runtime) => total + (runtime.progress ? pick(runtime.progress) : 0), 0);

    const projects: ProjectProgress[] = [];
    for (const runtime of this.runtimes) {
      if (runtime.progress) projects.push(...runtime.progress.projects);
    }

    const startedAt = this.runtimes.reduce<number | null>((earliest, runtime) => {
      const value = runtime.progress?.startedAt ?? null;
      if (value === null) return earliest;
      return earliest === null || value < earliest ? value : earliest;
    }, null);

    // Le débit affiché est la somme des débits observés : c'est la charge réelle
    // que l'utilisateur impose à son infrastructure, tous serveurs confondus.
    const rate: RateLimiterStats = {
      currentRpm: instances.reduce((total, i) => total + i.rate.currentRpm, 0),
      targetRpm: instances.reduce((total, i) => total + i.rate.targetRpm, 0),
      observedRpm: instances.reduce((total, i) => total + i.rate.observedRpm, 0),
      active: instances.reduce((total, i) => total + i.rate.active, 0),
      queued: instances.reduce((total, i) => total + i.rate.queued, 0),
      throttled: instances.some((i) => i.rate.throttled),
      penalties: instances.reduce((total, i) => total + i.rate.penalties, 0),
    };

    const fatal = instances.filter((i) => i.error !== null);

    return {
      phase: this.overallPhase(instances),
      message: this.overallMessage(instances),
      projectsTotal: sum((p) => p.projectsTotal),
      projectsPlanned: sum((p) => p.projectsPlanned),
      projectsSkipped: sum((p) => p.projectsSkipped),
      projectsDone: sum((p) => p.projectsDone),
      projectsError: sum((p) => p.projectsError),
      overviewsDone: sum((p) => p.overviewsDone),
      overviewsPlanned: sum((p) => p.overviewsPlanned),
      commitsIngested: sum((p) => p.commitsIngested),
      requestsMade: sum((p) => p.requestsMade),
      startedAt,
      elapsedMs: startedAt === null ? 0 : Date.now() - startedAt,
      etaMs: this.aggregateEta(),
      rate,
      projects,
      // Une instance en échec n'est PAS une erreur fatale globale : les autres
      // ont pu aboutir, et leurs données restent exploitables.
      fatalError: fatal.length === instances.length && fatal.length > 0 ? fatal[0]!.error : null,
      instances,
    };
  }

  private overallPhase(instances: InstanceProgress[]): SyncPhase {
    if (instances.length === 0) return 'idle';
    if (this.isPaused) return 'paused';
    // Tant qu'une instance travaille, l'ensemble travaille.
    const order: SyncPhase[] = ['discovering', 'overview', 'commits'];
    for (const phase of order) {
      if (instances.some((i) => i.phase === phase)) return phase;
    }
    if (instances.every((i) => i.phase === 'cancelled')) return 'cancelled';
    if (instances.every((i) => i.phase === 'error')) return 'error';
    if (instances.every((i) => i.phase === 'done' || i.phase === 'error' || i.phase === 'cancelled')) {
      return 'done';
    }
    return 'idle';
  }

  private overallMessage(instances: InstanceProgress[]): string {
    if (instances.length === 1) return instances[0]!.message;
    const active = instances.filter((i) => i.phase === 'overview' || i.phase === 'commits');
    if (active.length > 0) {
      return `${active.length} instance(s) en cours sur ${instances.length}`;
    }
    const failed = instances.filter((i) => i.error !== null).length;
    const done = instances.length - failed;
    return failed > 0
      ? `${done} instance(s) synchronisée(s), ${failed} en erreur`
      : `${instances.length} instances synchronisées`;
  }

  private aggregateEta(): number | null {
    const values = this.runtimes
      .map((runtime) => runtime.progress?.etaMs ?? null)
      .filter((value): value is number => value !== null);
    if (values.length === 0) return null;
    // Les instances avancent en parallèle : l'attente est celle de la plus lente.
    return Math.max(...values);
  }
}
