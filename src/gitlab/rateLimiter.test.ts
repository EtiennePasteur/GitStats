import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter, AbortError } from './rateLimiter';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lance `count` acquisitions et note l'instant auquel chacune est autorisée. */
function launch(limiter: RateLimiter, count: number, signal?: AbortSignal) {
  const startedAt: number[] = [];
  const releases: Array<() => void> = [];
  const settled: Array<Promise<'ok' | 'ko'>> = [];
  for (let i = 0; i < count; i++) {
    settled.push(
      limiter
        .acquire(signal)
        .then((release) => {
          startedAt.push(Date.now());
          releases.push(release);
          return 'ok' as const;
        })
        .catch(() => 'ko' as const),
    );
  }
  return { startedAt, releases, settled };
}

describe('RateLimiter — concurrence', () => {
  it('ne laisse jamais partir plus de maxConcurrent requêtes en parallèle', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60_000, maxConcurrent: 3 });
    const { startedAt, releases } = launch(limiter, 10);

    await vi.advanceTimersByTimeAsync(100);
    expect(startedAt).toHaveLength(3);
    expect(limiter.stats().active).toBe(3);
    expect(limiter.stats().queued).toBe(7);

    releases[0]!();
    await vi.advanceTimersByTimeAsync(1);
    expect(startedAt).toHaveLength(4);

    // On draine tout : rien ne doit rester coincé.
    for (let i = 0; i < 20; i++) {
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(startedAt).toHaveLength(10);
  });

  it('libérer deux fois le même slot ne crée pas de place fantôme', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60_000, maxConcurrent: 2 });
    const { startedAt, releases } = launch(limiter, 5);
    await vi.advanceTimersByTimeAsync(10);
    expect(startedAt).toHaveLength(2);

    const release = releases[0]!;
    release();
    release();
    release();
    await vi.advanceTimersByTimeAsync(10);

    // Une seule place libérée ⇒ une seule requête supplémentaire.
    expect(startedAt).toHaveLength(3);
    expect(limiter.stats().active).toBe(2);
  });
});

describe('RateLimiter — token bucket', () => {
  it('étale les départs au débit demandé', async () => {
    // 60 req/min = 1 req/s, capacité de rafale = 1.
    const limiter = new RateLimiter({ requestsPerMinute: 60, maxConcurrent: 1 });
    const { startedAt, releases } = launch(limiter, 4);

    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt).toHaveLength(1); // la rafale initiale
    releases[0]!();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(startedAt).toHaveLength(2);
    releases[1]!();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(startedAt).toHaveLength(3);
  });

  it('ne dépasse pas le débit cible sur une minute pleine', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 120, maxConcurrent: 8 });
    const { startedAt, releases } = launch(limiter, 500);

    // On relâche immédiatement chaque slot pour isoler l'effet du débit.
    const drain = setInterval(() => {
      while (releases.length > 0) releases.shift()!();
    }, 10);

    await vi.advanceTimersByTimeAsync(60_000);
    clearInterval(drain);

    // 120/min sur 60s, plus la rafale initiale, avec une marge d'arrondi.
    expect(startedAt.length).toBeGreaterThan(100);
    expect(startedAt.length).toBeLessThanOrEqual(130);
  });
});

describe('RateLimiter — AIMD', () => {
  it('divise le débit par deux à chaque pénalité, sans passer sous le plancher', () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 400,
      maxConcurrent: 6,
      minRequestsPerMinute: 50,
    });
    expect(limiter.stats().currentRpm).toBe(400);
    expect(limiter.stats().throttled).toBe(false);

    limiter.penalize();
    expect(limiter.stats().currentRpm).toBe(200);
    expect(limiter.stats().throttled).toBe(true);

    // Deux pénalités rapprochées ne comptent que pour une : une rafale de 429
    // issue d'un même dépassement ne doit pas effondrer le débit.
    limiter.penalize();
    expect(limiter.stats().currentRpm).toBe(200);

    vi.advanceTimersByTime(2_000);
    limiter.penalize();
    expect(limiter.stats().currentRpm).toBe(100);

    vi.advanceTimersByTime(2_000);
    limiter.penalize();
    vi.advanceTimersByTime(2_000);
    limiter.penalize();
    expect(limiter.stats().currentRpm).toBe(50); // plancher tenu

    expect(limiter.stats().penalties).toBe(5);
  });

  it('remonte le débit par paliers après une accalmie', () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 400,
      maxConcurrent: 6,
      minRequestsPerMinute: 50,
      recoveryDelayMs: 30_000,
      recoveryStepMs: 10_000,
    });
    limiter.penalize();
    expect(limiter.stats().currentRpm).toBe(200);

    // Avant la fin du délai de garde : aucune remontée.
    vi.advanceTimersByTime(20_000);
    limiter.reportSuccess();
    expect(limiter.stats().currentRpm).toBe(200);

    // Passé le délai, +10% de la cible par palier.
    vi.advanceTimersByTime(15_000);
    limiter.reportSuccess();
    expect(limiter.stats().currentRpm).toBe(240);

    vi.advanceTimersByTime(10_000);
    limiter.reportSuccess();
    expect(limiter.stats().currentRpm).toBe(280);

    // Et jamais au-dessus de la cible.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(10_000);
      limiter.reportSuccess();
    }
    expect(limiter.stats().currentRpm).toBe(400);
    expect(limiter.stats().throttled).toBe(false);
  });

  it('ralentit réellement les départs après une pénalité', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 600, maxConcurrent: 4 });
    const { startedAt, releases } = launch(limiter, 50);
    const drain = setInterval(() => {
      while (releases.length > 0) releases.shift()!();
    }, 5);

    await vi.advanceTimersByTimeAsync(2_000);
    const beforePenalty = startedAt.length;

    limiter.penalize(); // 600 -> 300 req/min
    await vi.advanceTimersByTimeAsync(2_000);
    const afterPenalty = startedAt.length - beforePenalty;
    clearInterval(drain);

    expect(afterPenalty).toBeLessThan(beforePenalty);
  });
});

describe('RateLimiter — annulation', () => {
  it('rejette les acquisitions en attente quand le signal est abort', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60, maxConcurrent: 1 });
    const controller = new AbortController();
    const { settled, releases } = launch(limiter, 5, controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    const results = await Promise.all(settled);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'ko')).toHaveLength(4);
    expect(limiter.stats().queued).toBe(0);
  });

  it('rejette immédiatement si le signal est déjà abort', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 600, maxConcurrent: 4 });
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.acquire(controller.signal)).rejects.toBeInstanceOf(AbortError);
  });

  it('dispose() vide la file et rejette tout ce qui attend', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60, maxConcurrent: 1 });
    const { settled } = launch(limiter, 4);
    await vi.advanceTimersByTimeAsync(0);

    limiter.dispose();
    await vi.advanceTimersByTimeAsync(0);

    const results = await Promise.all(settled);
    expect(results.filter((r) => r === 'ko')).toHaveLength(3);
    await expect(limiter.acquire()).rejects.toBeInstanceOf(AbortError);
  });
});

describe('RateLimiter — run()', () => {
  it('libère le slot même si la tâche échoue', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60_000, maxConcurrent: 1 });

    // On capture le rejet dès la création : avancer les timers avant d'attacher
    // le handler produirait une unhandled rejection transitoire.
    const failing = limiter
      .run(async () => {
        throw new Error('boom');
      })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    await vi.advanceTimersByTimeAsync(10);
    expect((await failing)?.message).toBe('boom');

    // Le slot est bien rendu malgré l'exception : sinon la suite resterait bloquée.
    expect(limiter.stats().active).toBe(0);

    const next = limiter.run(async () => 'ok');
    await vi.advanceTimersByTimeAsync(10);
    await expect(next).resolves.toBe('ok');
    expect(limiter.stats().active).toBe(0);
  });
});
