/**
 * Ordonnanceur de requêtes : token bucket + sémaphore de concurrence + AIMD.
 *
 * Pourquoi cette complexité : les headers `RateLimit-*` et `Retry-After` de GitLab
 * ne sont PAS dans `Access-Control-Expose-Headers`, donc invisibles depuis un
 * contexte cross-origin (vérifié sur gitlab.com et sur une instance auto-hébergée).
 * On ne peut donc pas piloter le débit sur ce que le serveur annonce : le limiteur
 * doit se calibrer tout seul à partir du seul signal observable, le code 429.
 *
 * Stratégie AIMD (Additive Increase / Multiplicative Decrease), la même que TCP :
 *  - un 429/5xx divise le débit courant par 2 (plancher `minRequestsPerMinute`) ;
 *  - après `recoveryDelayMs` sans incident, on remonte par paliers additifs
 *    jusqu'au débit cible.
 * Le débit converge ainsi vers ce que l'instance tolère réellement, sans jamais
 * lire un header.
 *
 * Aucune dépendance React : ce module doit pouvoir tourner dans un Web Worker.
 */

export interface RateLimiterOptions {
  /** Débit cible (plafond). Défaut 400/min, très en dessous des 2000/min de GitLab. */
  requestsPerMinute: number;
  /** Nombre de requêtes en vol simultanées. */
  maxConcurrent: number;
  /** Plancher sous lequel l'AIMD ne descend jamais. */
  minRequestsPerMinute?: number;
  /** Délai sans incident avant de commencer à remonter le débit. */
  recoveryDelayMs?: number;
  /** Intervalle entre deux paliers de remontée. */
  recoveryStepMs?: number;
}

export interface RateLimiterStats {
  /** Débit autorisé à l'instant T (≤ target si l'AIMD a mordu). */
  currentRpm: number;
  targetRpm: number;
  /** Requêtes réellement parties sur les 60 dernières secondes. */
  observedRpm: number;
  active: number;
  queued: number;
  /** true tant que le débit est bridé sous la cible. */
  throttled: boolean;
  /** Nombre total de 429/5xx encaissés depuis le démarrage. */
  penalties: number;
}

/** Libère le slot de concurrence. Doit être appelé quoi qu'il arrive (finally). */
export type ReleaseFn = () => void;

interface Waiter {
  resolve: (release: ReleaseFn) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class AbortError extends Error {
  override readonly name = 'AbortError';
  constructor(message = 'Requête annulée') {
    super(message);
  }
}

const MINUTE = 60_000;

export class RateLimiter {
  private readonly targetRpm: number;
  private readonly minRpm: number;
  private readonly recoveryDelayMs: number;
  private readonly recoveryStepMs: number;

  private maxConcurrent: number;
  private currentRpm: number;

  /** Token bucket. La capacité borne la rafale initiale. */
  private tokens: number;
  private readonly capacity: number;
  private lastRefillAt: number;

  private active = 0;
  private readonly waiting: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  private lastPenaltyAt = 0;
  private lastRecoveryAt = 0;
  private penalties = 0;
  /** Horodatages des départs, fenêtre glissante d'une minute. */
  private readonly recentStarts: number[] = [];

  private disposed = false;

  constructor(options: RateLimiterOptions) {
    this.targetRpm = Math.max(1, options.requestsPerMinute);
    this.minRpm = Math.max(1, options.minRequestsPerMinute ?? Math.min(30, this.targetRpm));
    this.maxConcurrent = Math.max(1, options.maxConcurrent);
    this.recoveryDelayMs = options.recoveryDelayMs ?? 30_000;
    this.recoveryStepMs = options.recoveryStepMs ?? 10_000;

    this.currentRpm = this.targetRpm;
    // Rafale plafonnée : on autorise au plus 1s de débit d'avance, et jamais
    // plus que la concurrence max (sinon la rafale initiale ne sert à rien).
    this.capacity = Math.max(1, Math.min(this.maxConcurrent, Math.ceil(this.targetRpm / 60)));
    this.tokens = this.capacity;
    this.lastRefillAt = Date.now();
    this.lastRecoveryAt = this.lastRefillAt;
  }

  /**
   * Attend l'autorisation de partir. Résout avec la fonction de libération du
   * slot de concurrence, que l'appelant DOIT invoquer dans un `finally`.
   */
  acquire(signal?: AbortSignal): Promise<ReleaseFn> {
    if (this.disposed) return Promise.reject(new AbortError('Ordonnanceur arrêté'));
    if (signal?.aborted) return Promise.reject(new AbortError());

    return new Promise<ReleaseFn>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.waiting.indexOf(waiter);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new AbortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
      this.pump();
    });
  }

  /** Enveloppe `acquire` + libération automatique. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * À appeler sur 429 / 5xx : division du débit par deux.
   * Idempotent dans une fenêtre courte pour qu'une rafale de 429 issue d'un même
   * dépassement ne fasse pas s'effondrer le débit à coups de divisions successives.
   */
  penalize(): void {
    const now = Date.now();
    this.penalties += 1;
    if (now - this.lastPenaltyAt < 1_000) {
      this.lastPenaltyAt = now;
      return;
    }
    this.lastPenaltyAt = now;
    this.lastRecoveryAt = now;
    this.currentRpm = Math.max(this.minRpm, Math.floor(this.currentRpm / 2));
    // On purge les jetons accumulés : inutile de partir en rafale juste après
    // s'être fait jeter.
    this.tokens = 0;
    this.lastRefillAt = now;
  }

  /** À appeler sur une réponse OK : alimente la remontée progressive. */
  reportSuccess(): void {
    this.recover();
  }

  setMaxConcurrent(value: number): void {
    this.maxConcurrent = Math.max(1, value);
    this.pump();
  }

  stats(): RateLimiterStats {
    const now = Date.now();
    this.trimRecent(now);
    return {
      currentRpm: this.currentRpm,
      targetRpm: this.targetRpm,
      observedRpm: this.recentStarts.length,
      active: this.active,
      queued: this.waiting.length,
      throttled: this.currentRpm < this.targetRpm,
      penalties: this.penalties,
    };
  }

  /** Rejette tout ce qui attend et empêche toute nouvelle acquisition. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.pop()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(new AbortError('Ordonnanceur arrêté'));
    }
  }

  // --- interne ---------------------------------------------------------

  private refill(now: number): void {
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.currentRpm) / MINUTE);
    this.lastRefillAt = now;
  }

  /** Remontée additive : +10% de la cible par palier, après une accalmie. */
  private recover(): void {
    if (this.currentRpm >= this.targetRpm) return;
    const now = Date.now();
    if (now - this.lastPenaltyAt < this.recoveryDelayMs) return;
    if (now - this.lastRecoveryAt < this.recoveryStepMs) return;
    this.lastRecoveryAt = now;
    const step = Math.max(1, Math.ceil(this.targetRpm / 10));
    this.currentRpm = Math.min(this.targetRpm, this.currentRpm + step);
  }

  private trimRecent(now: number): void {
    const cutoff = now - MINUTE;
    while (this.recentStarts.length > 0 && this.recentStarts[0]! < cutoff) {
      this.recentStarts.shift();
    }
  }

  private pump(): void {
    if (this.disposed) return;
    const now = Date.now();
    this.refill(now);
    this.recover();

    while (this.waiting.length > 0 && this.active < this.maxConcurrent && this.tokens >= 1) {
      const waiter = this.waiting.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(new AbortError());
        continue;
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      this.tokens -= 1;
      this.active += 1;
      this.recentStarts.push(now);
      waiter.resolve(this.makeRelease());
    }

    this.trimRecent(now);
    this.scheduleNextPump();
  }

  private makeRelease(): ReleaseFn {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.pump();
    };
  }

  /**
   * Réarme le pump uniquement si l'attente est due au manque de jetons.
   * Si elle est due à la concurrence, c'est `release()` qui relancera — inutile
   * de faire tourner un timer pour rien.
   */
  private scheduleNextPump(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.waiting.length === 0) return;
    if (this.active >= this.maxConcurrent && this.tokens >= 1) return;

    const missing = Math.max(0, 1 - this.tokens);
    const msPerToken = MINUTE / this.currentRpm;
    let delay = Math.ceil(missing * msPerToken);

    // Si le débit est bridé, on repasse régulièrement pour tenter la remontée.
    if (this.currentRpm < this.targetRpm) {
      delay = Math.min(delay, this.recoveryStepMs);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, delay));
  }
}
