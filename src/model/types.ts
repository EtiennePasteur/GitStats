/** Modèle de données interne, indépendant des payloads GitLab. */

/** Une instance GitLab déclarée par l'utilisateur. */
export interface GitLabInstance {
  /** Slug dérivé de l'origine — voir `instanceId`. */
  id: string;
  /** Racine normalisée, ex. `https://gitlab.example.com`. */
  host: string;
  /** Libellé affiché, éditable. Par défaut le nom d'hôte. */
  label: string;
  /** Compte reconnu à la validation du token. */
  user: { id: number; username: string; name: string } | null;
  addedAt: string;
  /**
   * Dernière erreur d'authentification. Renseignée plutôt que fatale : un token
   * expiré sur une instance ne doit pas empêcher les autres de se synchroniser.
   */
  authError: string | null;
}

/**
 * Identifiant d'instance, dérivé de l'origine.
 *
 * Déterministe à dessein : réimporter un fichier ou ré-ajouter la même instance
 * retombe sur le même identifiant, donc sur les mêmes données, au lieu de créer
 * un doublon. Réduit à `[a-z0-9-]` pour ne jamais entrer en conflit avec les
 * séparateurs de clés (`~` et `|`).
 */
export function instanceId(host: string): string {
  const withoutScheme = host.trim().toLowerCase().replace(/^https?:\/\//, '');
  return withoutScheme.replace(/\/+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Identifiant de projet, unique TOUTES INSTANCES CONFONDUES : `${instanceId}~${gitlabId}`.
 *
 * Les identifiants numériques de GitLab sont des séquences propres à chaque
 * serveur — le projet 42 de l'instance A n'a rien à voir avec le projet 42 de
 * l'instance B. Les confondre ferait conclure au planificateur « déjà connu,
 * inchangé », et un dépôt entier serait ignoré en silence.
 *
 * Le séparateur `~` est non réservé en URL : la clé traverse la route
 * `/projets/:key` du routeur à hash sans encodage, là où `#` ou `:` casserait.
 */
export type ProjectKey = string;

export function projectKey(instance: string, gitlabId: number): ProjectKey {
  return `${instance}~${gitlabId}`;
}

export function parseProjectKey(key: ProjectKey): { instanceId: string; gitlabId: number } {
  const at = key.lastIndexOf('~');
  if (at < 0) return { instanceId: '', gitlabId: Number.NaN };
  return { instanceId: key.slice(0, at), gitlabId: Number.parseInt(key.slice(at + 1), 10) };
}

export function instanceOfProject(key: ProjectKey): string {
  return parseProjectKey(key).instanceId;
}

export type ProjectSyncState =
  | 'pending' // en file, rien de fait
  | 'overview' // aperçu contributeurs récupéré
  | 'commits' // pagination des commits en cours
  | 'done' // fenêtre entièrement couverte
  | 'skipped' // inchangé depuis le dernier sync → 0 appel
  | 'empty' // dépôt vide
  | 'error';

export interface ProjectSyncRecord {
  state: ProjectSyncState;
  /** Bornes de la fenêtre temporelle déjà couverte par le sync détaillé (ISO). */
  coveredFrom: string | null;
  coveredUntil: string | null;
  /** `last_activity_at` observé lors du dernier sync réussi — moteur de l'incrémental. */
  syncedActivityAt: string | null;
  lastSyncedAt: string | null;
  commitCount: number;
  /** SHA des commits récents, pour dédupliquer la zone de recouvrement. */
  recentShas: string[];
  hasOverview: boolean;
  error: string | null;
  /** Page en cours, pour l'affichage temps réel pendant le sync. */
  currentPage: number;
  /**
   * Empreinte des options qui changent la NATURE des données collectées
   * (`with_stats`, toutes branches ou non). Si elle change, les seaux existants
   * sont incomparables aux nouveaux — par exemple activer `with_stats` après coup
   * laisserait tout l'historique à 0 ligne ajoutée. On force alors un re-sync
   * complet du projet.
   */
  fingerprint: string;
}

/** Empreinte des options de collecte. Voir `ProjectSyncRecord.fingerprint`. */
export function collectionFingerprint(config: Pick<SyncConfig, 'withStats' | 'allBranches'>): string {
  return `stats=${config.withStats ? 1 : 0};branches=${config.allBranches ? 'all' : 'default'}`;
}

/**
 * Profondeur du recouvrement des syncs incrémentaux, en jours.
 *
 * Utilisée à DEUX endroits qui doivent rester cohérents :
 *  - la borne basse des requêtes incrémentales (`planner`) ;
 *  - la fenêtre de SHA mémorisés pour la déduplication (`aggregate`).
 *
 * Si la seconde était plus courte que la première, les commits de la zone de
 * recouvrement seraient recomptés à chaque sync et les chiffres gonfleraient
 * silencieusement.
 */
export const OVERLAP_DAYS = 7;
export const OVERLAP_MS = OVERLAP_DAYS * 86_400_000;

export interface StoredProject {
  /** `${instanceId}~${gitlabId}` — identité utilisée partout dans l'application. */
  key: ProjectKey;
  /** Identifiant numérique côté GitLab, pour construire les appels API. */
  gitlabId: number;
  instanceId: string;
  name: string;
  nameWithNamespace: string;
  pathWithNamespace: string;
  namespaceFullPath: string;
  defaultBranch: string | null;
  webUrl: string;
  avatarUrl: string | null;
  createdAt: string;
  archived: boolean;
  lastActivityAt: string;
  /**
   * Écarte le dépôt de tous les calculs sans supprimer ses données.
   * Sert notamment à ne compter qu'une fois un dépôt mirroré entre instances.
   */
  excluded?: boolean;
  /**
   * Retire le dépôt des statistiques sur décision de l'utilisateur, sans arrêter
   * sa collecte. Réversible à la lecture par `Filters.excludeMuted`.
   *
   * Distinct de `excluded`, qui est structurel : un miroir écarté doit le rester
   * en toutes circonstances, sinon son code compte deux fois.
   */
  muted?: boolean;
  sync: ProjectSyncRecord;
}

/** Une personne, après fusion des identités Git (nom + e-mail) qui la désignent. */
export interface StoredAuthor {
  /** Clé canonique stable, dérivée de l'e-mail normalisé. */
  id: string;
  displayName: string;
  primaryEmail: string;
  /** Toutes les clés d'identité rattachées (dont `id`). */
  identityKeys: string[];
  /** Variantes de noms rencontrées, pour l'UI de fusion. */
  knownNames: string[];
  knownEmails: string[];
  isBot: boolean;
  gitlabUsername?: string;
  avatarUrl?: string;
  /** true si la fusion a été décidée manuellement (protège des ré-évaluations auto). */
  manual?: boolean;
}

/**
 * Le cœur du stockage : un seau par (projet, auteur, jour).
 * On n'archive jamais les commits bruts — sur 234 dépôts × 12 mois, cela
 * représenterait des centaines de Mo pour aucun gain d'analyse.
 */
export interface DailyBucket {
  /** `${projectKey}|${authorId}|${day}` */
  key: string;
  projectKey: ProjectKey;
  authorId: string;
  /** `YYYY-MM-DD`, en heure locale de l'auteur du commit. */
  day: string;
  commits: number;
  additions: number;
  deletions: number;
  /** Commits de merge (parent_ids > 1), comptés à part pour pouvoir les exclure. */
  merges: number;
  /**
   * Répartition horaire, en paires `[heure, commits]` triées par heure croissante
   * (voir `model/hours.ts`). INCLUT les commits de merge.
   *
   * Invariant : somme des compteurs === `commits`. Tout seau en porte une, ce qui
   * dispense la lecture de distinguer « pas d'heure » de « heure à zéro ».
   */
  hourly: number[];
  /**
   * Sous-ensemble de `hourly` limité aux merges — jamais un complément : les
   * additionner compterait deux fois. `[]` quand le seau ne porte aucun merge,
   * exactement comme `merges` y vaut zéro.
   */
  hourlyMerges: number[];
}

/** Aperçu all-time issu de `repository/contributors` (1 appel/projet). */
export interface ProjectOverview {
  projectKey: ProjectKey;
  fetchedAt: string;
  entries: Array<{
    authorId: string;
    commits: number;
    additions: number;
    deletions: number;
  }>;
}

/** Fil d'activité : borné aux N derniers commits par projet. */
export interface RecentCommit {
  key: string; // `${projectKey}|${sha}`
  projectKey: ProjectKey;
  sha: string;
  shortSha: string;
  authorId: string;
  date: string;
  title: string;
  additions: number;
  deletions: number;
  isMerge: boolean;
  webUrl: string;
}

export interface SyncWindow {
  /** ISO. `null` = depuis toujours. */
  from: string | null;
  until: string;
}

export interface SyncConfig {
  /** Nombre de mois d'historique, `null` = tout. */
  windowMonths: number | null;
  membership: boolean;
  includeArchived: boolean;
  allBranches: boolean;
  withStats: boolean;
  requestsPerMinute: number;
  maxConcurrent: number;
  excludeBots: boolean;
  excludeMerges: boolean;
  botPatterns: string[];
  /**
   * Force une collecte complète de tous les projets, en ignorant l'incrémental.
   * Coûteux (retour au budget du 1ᵉʳ sync) mais seul moyen de rattraper des
   * commits anciens arrivés via le merge d'une branche de longue durée.
   * Non persisté : c'est une action ponctuelle, pas un réglage.
   */
  forceFullResync?: boolean;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  windowMonths: 12,
  membership: true,
  includeArchived: false,
  allBranches: false,
  withStats: true,
  requestsPerMinute: 400,
  maxConcurrent: 6,
  excludeBots: true,
  excludeMerges: false,
  botPatterns: [
    'bot',
    'jenkins',
    'gitlab-ci',
    'sonarqube',
    'renovate',
    'dependabot',
    'noreply',
    'service-account',
    'svc_',
  ],
};

export interface StoredMeta {
  /** Instances déclarées. Les tokens, eux, ne sont jamais persistés ici. */
  instances: GitLabInstance[];
  /** Fenêtre effectivement couverte, tous projets confondus. */
  window: SyncWindow | null;
  lastSyncAt: string | null;
  config: SyncConfig;
  /** Fusions manuelles : clé d'identité → id d'auteur canonique. */
  manualAliases: Record<string, string>;
}
