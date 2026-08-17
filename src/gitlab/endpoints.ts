/**
 * Appels GitLab utilisés par le moteur de sync, typés et documentés avec leur coût.
 */

import type { GitLabClient, QueryParams } from './client';
import { paginate, fetchAllPages, type Page } from './paginate';
import { GitLabNotFoundError, GitLabForbiddenError } from './errors';
import type {
  GitLabUser,
  GitLabProjectSimple,
  GitLabContributor,
  GitLabCommit,
  GitLabUserSearchResult,
} from './types';

/** Coût : 1 appel. Valide le token avant de lancer quoi que ce soit. */
export async function getCurrentUser(client: GitLabClient, signal?: AbortSignal): Promise<GitLabUser> {
  const response = await client.get<GitLabUser>('user', undefined, signal);
  return response.data;
}

export interface ListProjectsOptions {
  /** `true` = uniquement les projets dont l'utilisateur est membre (direct ou hérité). */
  membership?: boolean;
  includeArchived?: boolean;
  /** 10 Guest, 20 Reporter, 30 Developer… Laisser vide pour tout ce qui est accessible. */
  minAccessLevel?: number;
  /** Filtre serveur : ne renvoie que les projets actifs depuis cette date. */
  lastActivityAfter?: string;
}

/**
 * Coût : ~1 appel / 100 projets (3 appels pour 234 dépôts).
 *
 * `simple=true` allège fortement le payload tout en conservant les seuls champs
 * dont on a besoin — dont `last_activity_at`, qui est la clé de l'incrémental :
 * il arrive gratuitement ici et permet ensuite de sauter les dépôts inchangés
 * sans le moindre appel supplémentaire.
 */
export function iterateProjects(
  client: GitLabClient,
  options: ListProjectsOptions = {},
  signal?: AbortSignal,
): AsyncGenerator<Page<GitLabProjectSimple>, void, undefined> {
  const params: QueryParams = {
    simple: true,
    membership: options.membership ?? true,
    order_by: 'last_activity_at',
    sort: 'desc',
    min_access_level: options.minAccessLevel,
    last_activity_after: options.lastActivityAfter,
  };
  // `archived` non transmis = tout ; `archived=false` = actifs uniquement.
  if (!options.includeArchived) params['archived'] = false;

  return paginate<GitLabProjectSimple>(client, 'projects', params, { signal, perPage: 100 });
}

/**
 * Coût : 1 seul appel par projet, quel que soit le nombre de commits.
 *
 * Renvoie l'agrégat par contributeur (commits, additions, deletions) — c'est ce
 * qui permet d'afficher un classement global en ~40 s sur 234 dépôts.
 *
 * ⚠️ Ces chiffres sont ALL-TIME sur une seule branche et ne se filtrent pas par
 * date : ils servent d'aperçu, jamais de source pour les graphes temporels.
 *
 * Renvoie `null` si le dépôt est vide (404) ou inaccessible (403) — deux cas
 * parfaitement normaux qui ne doivent pas faire échouer le sync.
 */
export async function getContributors(
  client: GitLabClient,
  projectId: number,
  ref?: string | null,
  signal?: AbortSignal,
): Promise<GitLabContributor[] | null> {
  try {
    return await fetchAllPages<GitLabContributor>(
      client,
      `projects/${projectId}/repository/contributors`,
      { ref: ref ?? undefined, order_by: 'commits', sort: 'desc' },
      { signal, perPage: 100 },
    );
  } catch (error) {
    if (error instanceof GitLabNotFoundError || error instanceof GitLabForbiddenError) return null;
    throw error;
  }
}

export interface ListCommitsOptions {
  /** Borne basse incluse, ISO 8601. */
  since?: string;
  /** Borne haute incluse, ISO 8601. */
  until?: string;
  /** Branche à parcourir. Ignoré si `allBranches` est vrai. */
  refName?: string | null;
  /** `all=true` : tous les commits de toutes les références. Plus complet, plus lourd. */
  allBranches?: boolean;
  /**
   * `with_stats=true` ajoute additions/deletions par commit.
   * C'est le paramètre coûteux côté serveur (calcul de diff par commit) :
   * la concurrence est réduite quand il est actif.
   */
  withStats?: boolean;
}

/**
 * Coût : 1 appel par tranche de 100 commits de la fenêtre demandée.
 *
 * ⚠️ Cet endpoint ne renvoie ni `X-Total` ni `X-Total-Pages` : on ne peut pas
 * connaître le nombre de pages à l'avance, la progression est donc indéterminée
 * par projet (mais déterminée globalement, via le nombre de projets).
 */
export function iterateCommits(
  client: GitLabClient,
  projectId: number,
  options: ListCommitsOptions = {},
  signal?: AbortSignal,
): AsyncGenerator<Page<GitLabCommit>, void, undefined> {
  const params: QueryParams = {
    since: options.since,
    until: options.until,
    with_stats: options.withStats ? true : undefined,
  };
  if (options.allBranches) {
    params['all'] = true;
  } else if (options.refName) {
    params['ref_name'] = options.refName;
  }

  return paginate<GitLabCommit>(client, `projects/${projectId}/repository/commits`, params, {
    signal,
    perPage: 100,
  });
}

/**
 * Coût : 1 appel. Utilisé de façon paresseuse et plafonnée (top contributeurs
 * uniquement) pour récupérer un avatar et un username GitLab.
 */
export async function searchUsers(
  client: GitLabClient,
  query: string,
  signal?: AbortSignal,
): Promise<GitLabUserSearchResult[]> {
  try {
    const response = await client.get<GitLabUserSearchResult[]>(
      'users',
      { search: query, per_page: 5, active: true },
      signal,
    );
    return response.data;
  } catch (error) {
    if (error instanceof GitLabNotFoundError || error instanceof GitLabForbiddenError) return [];
    throw error;
  }
}
