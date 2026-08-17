/**
 * Migration du stockage v1 (mono-instance) vers v2 (multi-instances).
 *
 * En v1, un projet était identifié par son identifiant numérique GitLab. Ces
 * identifiants sont des séquences propres à chaque serveur : dès la seconde
 * instance, ils entrent en collision. La v2 les remplace par une clé
 * `${instanceId}~${gitlabId}`, unique toutes instances confondues.
 *
 * Toutes les données existantes appartiennent, par construction, à l'unique
 * instance déclarée à l'époque : la transformation consiste à les lui rattacher.
 * Les fusions manuelles d'identités vivent dans `meta` et ne sont pas touchées.
 *
 * Ces fonctions sont pures pour être testables sans IndexedDB — la partie
 * transactionnelle, elle, n'est qu'un aller-retour de lecture/écriture.
 */

import {
  projectKey,
  instanceId,
  type ProjectKey,
  type StoredProject,
  type DailyBucket,
  type ProjectOverview,
  type RecentCommit,
  type StoredMeta,
  type GitLabInstance,
} from '../model/types';

/** Formes v1 des enregistrements, telles qu'elles dorment encore en base. */
export interface V1Project extends Omit<StoredProject, 'key' | 'gitlabId' | 'instanceId'> {
  id: number;
}
export interface V1DailyBucket extends Omit<DailyBucket, 'projectKey'> {
  projectId: number;
}
export interface V1ProjectOverview extends Omit<ProjectOverview, 'projectKey'> {
  projectId: number;
}
export interface V1RecentCommit extends Omit<RecentCommit, 'projectKey'> {
  projectId: number;
}
/** `config` portait un `host` en v1 ; il remonte désormais dans l'instance. */
export interface V1Meta extends Omit<StoredMeta, 'instances' | 'config'> {
  host?: string;
  config?: StoredMeta['config'] & { host?: string };
}

export interface V1Snapshot {
  projects: V1Project[];
  daily: V1DailyBucket[];
  overviews: V1ProjectOverview[];
  recentCommits: V1RecentCommit[];
  meta: V1Meta | undefined;
}

export interface V2Snapshot {
  projects: StoredProject[];
  daily: DailyBucket[];
  overviews: ProjectOverview[];
  recentCommits: RecentCommit[];
  meta: StoredMeta | undefined;
  instance: GitLabInstance;
}

/**
 * Repli défensif : la v1 écrivait toujours `meta.host`, mais une base tronquée
 * pourrait ne rien exposer. Il doit rester NON VIDE — `instanceId('')` produirait
 * la clé de projet `~42` et la migration deviendrait incohérente.
 */
export const LEGACY_FALLBACK_HOST = 'https://gitlab.local';

/**
 * Reconstitue l'instance d'origine à partir des traces laissées en v1 :
 * `meta.host` d'abord, puis `meta.config.host`. Mieux vaut une étiquette
 * approximative que des données orphelines.
 */
export function inferLegacyHost(meta: V1Meta | undefined): string {
  return meta?.host ?? meta?.config?.host ?? LEGACY_FALLBACK_HOST;
}

export function legacyInstance(host: string, now: string): GitLabInstance {
  return {
    id: instanceId(host),
    host,
    label: host.replace(/^https?:\/\//, ''),
    user: null,
    addedAt: now,
    // Le token n'a jamais été stocké en base : il faudra le ressaisir. Ce n'est
    // pas une erreur d'authentification, seulement une reconnexion attendue.
    authError: null,
  };
}

export function migrateV1ToV2(snapshot: V1Snapshot, now: string): V2Snapshot {
  const host = inferLegacyHost(snapshot.meta);
  const instance = legacyInstance(host, now);
  const keyOf = (gitlabId: number): ProjectKey => projectKey(instance.id, gitlabId);

  const projects: StoredProject[] = snapshot.projects.map((project) => {
    const { id, ...rest } = project;
    return { ...rest, key: keyOf(id), gitlabId: id, instanceId: instance.id };
  });

  const daily: DailyBucket[] = snapshot.daily.map((bucket) => {
    const { projectId, ...rest } = bucket;
    const key = keyOf(projectId);
    // La clé du seau embarque l'identifiant de projet : elle doit être refaite,
    // sinon deux instances produiraient des clés identiques pour des seaux
    // différents et s'écraseraient mutuellement.
    return { ...rest, projectKey: key, key: `${key}|${bucket.authorId}|${bucket.day}` };
  });

  const overviews: ProjectOverview[] = snapshot.overviews.map((overview) => {
    const { projectId, ...rest } = overview;
    return { ...rest, projectKey: keyOf(projectId) };
  });

  const recentCommits: RecentCommit[] = snapshot.recentCommits.map((commit) => {
    const { projectId, ...rest } = commit;
    const key = keyOf(projectId);
    return { ...rest, projectKey: key, key: `${key}|${commit.sha}` };
  });

  const meta: StoredMeta | undefined =
    snapshot.meta === undefined
      ? undefined
      : (() => {
          const { host: _legacyHost, config, ...rest } = snapshot.meta;
          const { host: _configHost, ...cleanConfig } = config ?? {};
          return {
            ...rest,
            schemaVersion: 2,
            instances: [instance],
            config: cleanConfig as StoredMeta['config'],
          } as StoredMeta;
        })();

  return { projects, daily, overviews, recentCommits, meta, instance };
}
