/**
 * Sous-ensemble des payloads GitLab REST v4 réellement consommés par l'app.
 * On ne type que ce qu'on lit : GitLab renvoie bien plus de champs.
 */

/** `GET /user` — sert uniquement à valider le token à l'onboarding. */
export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  avatar_url: string | null;
  web_url: string;
}

/** `GET /projects?simple=true` */
export interface GitLabProjectSimple {
  id: number;
  name: string;
  path_with_namespace: string;
  name_with_namespace: string;
  default_branch: string | null;
  web_url: string;
  avatar_url: string | null;
  /** Clé de l'incrémental : si elle n'a pas bougé, le projet est ignoré. */
  last_activity_at: string;
  created_at: string;
  archived?: boolean;
  namespace: {
    id: number;
    name: string;
    path: string;
    full_path: string;
    kind: string;
  };
}

/** `GET /projects/:id/repository/contributors` — agrégat all-time, 1 seul appel. */
export interface GitLabContributor {
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
}

/** `GET /projects/:id/repository/commits` */
export interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  message?: string;
  author_name: string;
  author_email: string;
  authored_date: string;
  committer_name: string;
  committer_email: string;
  committed_date: string;
  /** Présent uniquement si `with_stats=true`. */
  stats?: { additions: number; deletions: number; total: number };
  /** > 1 parent ⇒ commit de merge. */
  parent_ids: string[];
  web_url: string;
}

/** `GET /users?search=` — enrichissement paresseux des avatars. */
export interface GitLabUserSearchResult {
  id: number;
  username: string;
  name: string;
  avatar_url: string | null;
  web_url: string;
}
