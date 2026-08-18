/**
 * Transformation commits bruts → seaux journaliers.
 *
 * Deux subtilités qui faussent silencieusement les chiffres si on les rate :
 *
 * 1. **Date d'auteur vs date de commit.** On rattache l'activité à `authored_date`
 *    (quand le travail a été fait) et non à `committed_date` (réécrit par tout
 *    rebase/cherry-pick). En revanche le curseur d'incrémental utilise
 *    `committed_date`, parce que c'est ce que filtrent les paramètres
 *    `since`/`until` de l'API. Mélanger les deux crée soit des trous, soit des
 *    doublons.
 *
 * 2. **Fuseau horaire.** La partie date d'un ISO 8601 avec offset
 *    (`2026-08-17T23:30:00+02:00`) EST déjà la date locale de l'auteur. Passer par
 *    `new Date()` puis `toISOString()` la convertirait en UTC et décalerait d'un
 *    jour tous les commits de soirée. On découpe donc la chaîne directement.
 */

import type { DailyBucket, RecentCommit, ProjectKey } from '../model/types';
import { OVERLAP_DAYS } from '../model/types';
import { addHour } from '../model/hours';
import type { GitLabCommit } from '../gitlab/types';
import type { IdentityResolver } from './identity';

/** `2026-08-17T23:30:00+02:00` → `2026-08-17` (jour local de l'auteur). */
export function localDay(isoDate: string): string {
  return isoDate.slice(0, 10);
}

/** `2026-08-17T23:30:00+02:00` → `23` (heure locale de l'auteur). */
export function localHour(isoDate: string): number {
  const hour = Number.parseInt(isoDate.slice(11, 13), 10);
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : 0;
}

/** Jour de la semaine du jour local (0 = dimanche), sans dérive de fuseau. */
export function localWeekday(isoDate: string): number {
  const day = new Date(`${localDay(isoDate)}T00:00:00Z`);
  return Number.isNaN(day.getTime()) ? 0 : day.getUTCDay();
}

export function bucketKey(projectKey: ProjectKey, authorId: string, day: string): string {
  return `${projectKey}|${authorId}|${day}`;
}

export interface IngestResult {
  buckets: DailyBucket[];
  recentCommits: RecentCommit[];
  /** SHA effectivement ingérés (les doublons en sont exclus). */
  ingestedShas: string[];
  ingestedCount: number;
  duplicateCount: number;
  /** `committed_date` le plus ancien / le plus récent vus — bornes du curseur. */
  oldestCommittedDate: string | null;
  newestCommittedDate: string | null;
}

/**
 * Agrège une volée de commits.
 *
 * `knownShas` porte la déduplication : les syncs incrémentaux se recouvrent
 * volontairement d'une heure pour ne rien perdre, ce recouvrement doit donc être
 * neutralisé ici, sinon les commits de la zone sont comptés deux fois à chaque
 * lancement.
 */
export function ingestCommits(
  projectKey: ProjectKey,
  commits: GitLabCommit[],
  resolver: IdentityResolver,
  knownShas: ReadonlySet<string>,
): IngestResult {
  const buckets = new Map<string, DailyBucket>();
  const recentCommits: RecentCommit[] = [];
  const ingestedShas: string[] = [];
  let duplicateCount = 0;
  let oldestCommittedDate: string | null = null;
  let newestCommittedDate: string | null = null;

  for (const commit of commits) {
    const committedDate = commit.committed_date || commit.authored_date;
    if (committedDate) {
      if (oldestCommittedDate === null || committedDate < oldestCommittedDate) {
        oldestCommittedDate = committedDate;
      }
      if (newestCommittedDate === null || committedDate > newestCommittedDate) {
        newestCommittedDate = committedDate;
      }
    }

    if (knownShas.has(commit.id)) {
      duplicateCount += 1;
      continue;
    }
    ingestedShas.push(commit.id);

    const authorId = resolver.observe({ name: commit.author_name, email: commit.author_email }, 1);
    const authoredDate = commit.authored_date || committedDate;
    const day = localDay(authoredDate);
    const isMerge = (commit.parent_ids?.length ?? 0) > 1;

    // Les lignes d'un commit de merge sont TOUJOURS écartées.
    //
    // GitLab calcule `stats` comme le diff face au premier parent : pour un merge
    // de branche, cela renvoie l'intégralité des modifications de la branche —
    // déjà comptées, commit par commit, juste avant. Les inclure double purement
    // et simplement le volume de lignes de tout dépôt qui merge ses branches,
    // et gonfle mécaniquement le score de celui qui appuie sur « Merge ».
    //
    // Le commit de merge reste compté dans `commits` et `merges` (c'est un acte
    // réel), mais il pèse zéro ligne.
    const additions = isMerge ? 0 : (commit.stats?.additions ?? 0);
    const deletions = isMerge ? 0 : (commit.stats?.deletions ?? 0);

    // L'heure descend dans le seau : c'est ce qui rend le rythme de travail
    // filtrable comme le reste. Le jour de la semaine, lui, ne se stocke pas —
    // il se déduit de `day` à la lecture (`localWeekday`).
    const hour = localHour(authoredDate);

    const key = bucketKey(projectKey, authorId, day);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, {
        key,
        projectKey,
        authorId,
        day,
        commits: 1,
        additions,
        deletions,
        merges: isMerge ? 1 : 0,
        hourly: [hour, 1],
        hourlyMerges: isMerge ? [hour, 1] : [],
      });
    } else {
      bucket.commits += 1;
      bucket.additions += additions;
      bucket.deletions += deletions;
      bucket.hourly = addHour(bucket.hourly, hour);
      if (isMerge) {
        bucket.merges += 1;
        bucket.hourlyMerges = addHour(bucket.hourlyMerges, hour);
      }
    }

    recentCommits.push({
      key: `${projectKey}|${commit.id}`,
      projectKey,
      sha: commit.id,
      shortSha: commit.short_id,
      authorId,
      date: committedDate,
      title: commit.title,
      additions,
      deletions,
      isMerge,
      webUrl: commit.web_url,
    });
  }

  return {
    buckets: [...buckets.values()],
    recentCommits,
    ingestedShas,
    ingestedCount: ingestedShas.length,
    duplicateCount,
    oldestCommittedDate,
    newestCommittedDate,
  };
}

/**
 * Réduit la liste des SHA mémorisés à ceux de la fenêtre de recouvrement.
 * Sans cette taille bornée, un dépôt actif accumulerait indéfiniment des SHA
 * dans IndexedDB pour un bénéfice nul.
 */
export function trimRecentShas(
  commits: Array<{ sha: string; date: string }>,
  now: Date,
  overlapDays = OVERLAP_DAYS,
  maxShas = 5_000,
): string[] {
  const cutoff = new Date(now.getTime() - overlapDays * 86_400_000).toISOString();
  return commits
    .filter((commit) => commit.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, maxShas)
    .map((commit) => commit.sha);
}
