/**
 * Planification du sync : décide, pour chaque projet, ce qu'il faut réellement
 * aller chercher. C'est ici que se joue l'essentiel de l'économie d'appels.
 *
 * Le levier principal est `last_activity_at`, qui arrive GRATUITEMENT dans la
 * liste des projets (vague 0). Si un dépôt n'a pas bougé depuis le dernier sync,
 * il coûte zéro appel. Sur un parc de 234 dépôts, une poignée seulement bouge
 * entre deux consultations : le 2ᵉ lancement passe de ~2 000 appels à moins de 100.
 *
 * `last_activity_at` bouge aussi pour des événements sans commit (issue, MR,
 * wiki). Le déclencheur est donc volontairement conservateur : il peut provoquer
 * une requête inutile d'une page, mais ne rate jamais un push.
 */

import type { StoredProject, SyncConfig, ProjectKey } from '../model/types';
import { collectionFingerprint, projectKey, OVERLAP_MS as OVERLAP } from '../model/types';
import type { GitLabProjectSimple } from '../gitlab/types';

export type RangeKind = 'initial' | 'incremental' | 'backfill' | 'refresh';

export interface FetchRange {
  /** ISO, borne basse. `null` = depuis l'origine du dépôt. */
  since: string | null;
  /** ISO, borne haute. */
  until: string;
  kind: RangeKind;
}

export interface ProjectPlan {
  projectKey: ProjectKey;
  gitlabId: number;
  /** `false` ⇒ zéro appel pour ce projet. */
  shouldSync: boolean;
  reason: string;
  ranges: FetchRange[];
  needsOverview: boolean;
  /** Vrai si les seaux existants doivent être purgés avant réécriture. */
  resetExisting: boolean;
}

export interface PlanSummary {
  plans: ProjectPlan[];
  toSync: number;
  skipped: number;
  /** Estimation basse du nombre d'appels (1 par aperçu + 1 page par plage). */
  minimumRequests: number;
}

/**
 * Le recouvrement n'est PAS une simple marge d'horloge.
 *
 * Les paramètres `since`/`until` de l'API filtrent sur la date de commit, or un
 * dépôt reçoit régulièrement des commits dont la date est bien antérieure au
 * push : merge d'une branche de fonctionnalité vivante depuis deux semaines,
 * retour de congés, travail hors ligne. Avec un recouvrement d'une heure, ces
 * commits tombent avant la borne basse et ne sont JAMAIS rattrapés, à aucun
 * sync ultérieur.
 *
 * Sept jours couvrent le cas courant pour un coût marginal (une page de plus par
 * dépôt actif, la déduplication par SHA neutralisant les doublons).
 *
 * Angle mort assumé : une branche mergée après plus de 7 jours de vie. D'où
 * l'option « Resynchronisation complète », seul moyen sûr de rattraper ce cas.
 */
export { OVERLAP_DAYS, OVERLAP_MS } from '../model/types';

export function windowStart(config: SyncConfig, now: Date): string | null {
  if (config.windowMonths === null) return null;
  const start = new Date(now);
  start.setMonth(start.getMonth() - config.windowMonths);
  return start.toISOString();
}

/**
 * Détermine le plan d'un projet.
 *
 * @param remote  ce que GitLab vient de renvoyer (vague 0)
 * @param stored  ce qu'on avait déjà, ou `undefined` si jamais synchronisé
 */
export function planProject(
  remote: GitLabProjectSimple,
  stored: StoredProject | undefined,
  config: SyncConfig,
  now: Date,
  instanceId: string,
): ProjectPlan {
  const until = now.toISOString();
  const desiredFrom = windowStart(config, now);
  const fingerprint = collectionFingerprint(config);

  const base = {
    projectKey: projectKey(instanceId, remote.id),
    gitlabId: remote.id,
    needsOverview: true,
    resetExisting: false,
  };

  // Resynchronisation complète demandée explicitement : on repart de zéro
  // partout. C'est le seul moyen de rattraper des commits anciens arrivés par
  // le merge d'une branche plus vieille que la fenêtre de recouvrement.
  if (config.forceFullResync) {
    return {
      ...base,
      shouldSync: true,
      reason: 'Resynchronisation complète demandée',
      resetExisting: true,
      ranges: [{ since: desiredFrom, until, kind: 'initial' }],
    };
  }

  // Jamais vu : collecte complète de la fenêtre.
  if (stored === undefined || stored.sync.coveredUntil === null) {
    return {
      ...base,
      shouldSync: true,
      reason: 'Premier chargement',
      ranges: [{ since: desiredFrom, until, kind: 'initial' }],
    };
  }

  // Les options de collecte ont changé : l'historique existant n'est plus
  // comparable, on repart de zéro sur ce projet.
  if (stored.sync.fingerprint !== fingerprint) {
    return {
      ...base,
      shouldSync: true,
      reason: 'Options de collecte modifiées',
      resetExisting: true,
      ranges: [{ since: desiredFrom, until, kind: 'initial' }],
    };
  }

  // Une erreur précédente doit être retentée, même si le dépôt n'a pas bougé.
  const previousFailed = stored.sync.state === 'error';

  const ranges: FetchRange[] = [];
  const reasons: string[] = [];

  // Fenêtre élargie (12 → 24 mois) : on ne va chercher QUE le trou manquant.
  const coveredFrom = stored.sync.coveredFrom;
  if (desiredFrom === null && coveredFrom !== null) {
    ranges.push({ since: null, until: coveredFrom, kind: 'backfill' });
    reasons.push("Extension à tout l'historique");
  } else if (desiredFrom !== null && coveredFrom !== null && desiredFrom < coveredFrom) {
    ranges.push({ since: desiredFrom, until: coveredFrom, kind: 'backfill' });
    reasons.push('Fenêtre élargie');
  }

  // Nouveauté depuis le dernier passage.
  const movedSinceLastSync =
    stored.sync.syncedActivityAt === null || remote.last_activity_at > stored.sync.syncedActivityAt;

  if (movedSinceLastSync || previousFailed) {
    const from = new Date(new Date(stored.sync.coveredUntil).getTime() - OVERLAP).toISOString();
    ranges.push({ since: from, until, kind: previousFailed ? 'refresh' : 'incremental' });
    reasons.push(previousFailed ? 'Nouvelle tentative après erreur' : 'Activité depuis le dernier sync');
  }

  if (ranges.length === 0) {
    return {
      ...base,
      shouldSync: false,
      needsOverview: false,
      reason: 'Inchangé depuis le dernier sync',
      ranges: [],
    };
  }

  return {
    ...base,
    shouldSync: true,
    // L'aperçu all-time ne sert qu'au premier passage : il ne se filtre pas par
    // date, donc le re-demander à chaque sync incrémental serait 234 appels
    // gaspillés pour une information déjà connue.
    needsOverview: !stored.sync.hasOverview,
    reason: reasons.join(' + '),
    ranges,
  };
}

/**
 * @param storedByKey projets DÉJÀ RESTREINTS à l'instance concernée.
 *
 * Les identifiants numériques GitLab sont des séquences par serveur : chercher
 * le projet `42` dans un dictionnaire toutes instances confondues retomberait
 * sur celui d'une autre instance, et le planificateur conclurait « inchangé,
 * zéro appel » sur un dépôt jamais vu.
 */
export function planSync(
  remoteProjects: GitLabProjectSimple[],
  storedByKey: ReadonlyMap<ProjectKey, StoredProject>,
  config: SyncConfig,
  now: Date,
  instanceId: string,
): PlanSummary {
  const plans = remoteProjects.map((remote) =>
    planProject(remote, storedByKey.get(projectKey(instanceId, remote.id)), config, now, instanceId),
  );
  const toSync = plans.filter((plan) => plan.shouldSync).length;
  const minimumRequests = plans.reduce(
    (total, plan) => total + (plan.needsOverview ? 1 : 0) + plan.ranges.length,
    0,
  );
  return { plans, toSync, skipped: plans.length - toSync, minimumRequests };
}
