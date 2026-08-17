/** Erreurs typées de la couche GitLab, pour que l'appelant décide quoi retenter. */

export class GitLabError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string | undefined;

  constructor(message: string, status: number, url: string, body?: string) {
    super(message);
    this.name = 'GitLabError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** 401 — token invalide/expiré. Fatal : on arrête tout et on renvoie à l'onboarding. */
export class GitLabAuthError extends GitLabError {
  constructor(url: string, body?: string) {
    super('Token GitLab invalide ou expiré (401).', 401, url, body);
    this.name = 'GitLabAuthError';
  }
}

/** 403 — droits insuffisants sur cette ressource. Non fatal : on saute le projet. */
export class GitLabForbiddenError extends GitLabError {
  constructor(url: string, body?: string) {
    super('Accès refusé à cette ressource (403).', 403, url, body);
    this.name = 'GitLabForbiddenError';
  }
}

/**
 * 404 — ressource absente. Cas courant et NON fatal : un dépôt vide renvoie 404
 * sur `repository/contributors` et `repository/commits`.
 */
export class GitLabNotFoundError extends GitLabError {
  constructor(url: string, body?: string) {
    super('Ressource introuvable (404).', 404, url, body);
    this.name = 'GitLabNotFoundError';
  }
}

/** Échec réseau / CORS / DNS — pas de réponse HTTP du tout. */
export class GitLabNetworkError extends GitLabError {
  constructor(url: string, cause: unknown) {
    super(
      `Échec réseau vers ${url}. Vérifiez l'URL de l'instance, votre connexion (VPN ?) et que l'API autorise le CORS.`,
      0,
      url,
    );
    this.name = 'GitLabNetworkError';
    this.cause = cause;
  }
}

/** Toutes les tentatives ont échoué. */
export class GitLabRetryExhaustedError extends GitLabError {
  readonly attempts: number;
  constructor(url: string, attempts: number, lastError: unknown) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    super(`Abandon après ${attempts} tentatives sur ${url} — ${detail}`, 0, url);
    this.name = 'GitLabRetryExhaustedError';
    this.attempts = attempts;
    this.cause = lastError;
  }
}

export function isFatalAuthError(error: unknown): error is GitLabAuthError {
  return error instanceof GitLabAuthError;
}
