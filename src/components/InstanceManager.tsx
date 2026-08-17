/**
 * Gestion de la liste des instances GitLab.
 *
 * Le même composant sert à l'onboarding et aux réglages : les tokens expirent,
 * il faut pouvoir en rajouter ou en retirer à tout moment, pas seulement à la
 * première connexion.
 *
 * Chaque ajout est validé par un `GET /user` AVANT d'être enregistré : on affiche
 * immédiatement le compte reconnu, et on évite de découvrir un 401 au bout de
 * deux cents appels.
 */

import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { instanceId as deriveInstanceId } from '../model/types';
import { normalizeHost } from '../gitlab/client';
import {
  Button,
  StatusBadge,
  Toggle,
  cx,
  formatRelative,
} from './ui/primitives';

export function InstanceManager({ compact = false }: { compact?: boolean }) {
  const instances = useAppStore((state) => state.instances);
  const tokens = useAppStore((state) => state.tokens);
  const rememberTokens = useAppStore((state) => state.rememberTokens);
  const addInstance = useAppStore((state) => state.addInstance);
  const removeInstance = useAppStore((state) => state.removeInstance);
  const renameInstance = useAppStore((state) => state.renameInstance);
  const setRememberTokens = useAppStore((state) => state.setRememberTokens);

  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');

  // Le lien n'apparaît qu'une fois une URL saisie : `normalizeHost('')` lève et
  // renvoie `null` ici. Un lien « créer un token » pointant vers un hôte
  // d'exemple serait pire que pas de lien du tout.
  const tokenUrl = (() => {
    try {
      return `${normalizeHost(host)}/-/user_settings/personal_access_tokens?name=GitStats&scopes=read_api`;
    } catch {
      return null;
    }
  })();

  const alreadyPresent = (() => {
    try {
      return instances.some((instance) => instance.id === deriveInstanceId(normalizeHost(host)));
    } catch {
      return false;
    }
  })();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await addInstance(host, token);
      setHost('');
      setToken('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {instances.length > 0 && (
        <ul className="space-y-2">
          {instances.map((instance) => {
            const hasToken = typeof tokens[instance.id] === 'string' && tokens[instance.id] !== '';
            return (
              <li
                key={instance.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[var(--border)] px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  {editing === instance.id ? (
                    <input
                      autoFocus
                      value={draftLabel}
                      onChange={(event) => setDraftLabel(event.target.value)}
                      onBlur={() => {
                        void renameInstance(instance.id, draftLabel.trim() || instance.label);
                        setEditing(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') setEditing(null);
                      }}
                      className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(instance.id);
                        setDraftLabel(instance.label);
                      }}
                      className="block cursor-text truncate text-left text-sm font-medium hover:underline"
                      title="Renommer"
                    >
                      {instance.label}
                    </button>
                  )}
                  <span className="block truncate text-xs text-[var(--text-muted)]">
                    {instance.host}
                    {instance.user !== null && ` · ${instance.user.name} (@${instance.user.username})`}
                    {` · ajoutée ${formatRelative(instance.addedAt)}`}
                  </span>
                </span>

                {instance.authError !== null ? (
                  <StatusBadge tone="critical">token à renouveler</StatusBadge>
                ) : hasToken ? (
                  <StatusBadge tone="good">connectée</StatusBadge>
                ) : (
                  // Les tokens ne sont pas persistés en base : après une nouvelle
                  // session, il faut les ressaisir. Ce n'est pas une anomalie.
                  <StatusBadge tone="warning">token à ressaisir</StatusBadge>
                )}

                <span className="flex gap-1.5">
                  <Button
                    onClick={() => {
                      setHost(instance.host);
                      setToken('');
                    }}
                  >
                    Reconnecter
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      const wipe = window.confirm(
                        `Retirer « ${instance.label} » ?\n\nOK : supprime aussi ses données locales.\nAnnuler : conserve les données (l'instance reste dans les statistiques).`,
                      );
                      void removeInstance(instance.id, wipe);
                    }}
                  >
                    Retirer
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div
        className={cx(
          'rounded-lg border border-dashed border-[var(--border)] p-3',
          instances.length === 0 && 'border-solid',
        )}
      >
        <p className="text-sm font-medium">
          {instances.length === 0 ? 'Connecter une instance GitLab' : 'Ajouter une instance'}
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            type="url"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="https://gitlab.example.com"
            className="h-9 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
          />
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="glpat-…"
            autoComplete="off"
            className="h-9 rounded-lg border border-[var(--border)] bg-transparent px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
          />
          <Button
            variant="primary"
            className="h-9"
            disabled={busy || host.trim() === '' || token.trim() === ''}
            onClick={() => void submit()}
          >
            {busy ? 'Vérification…' : alreadyPresent ? 'Reconnecter' : 'Ajouter'}
          </Button>
        </div>

        <p className="mt-2 text-xs text-[var(--text-muted)]">
          Portée <code className="rounded bg-[var(--surface-2)] px-1">read_api</code> suffisante.
          {tokenUrl !== null && (
            <>
              {' '}
              <a
                href={tokenUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[var(--series-1)] hover:underline"
              >
                Créer un token
              </a>
            </>
          )}
          {alreadyPresent && ' · Cette instance est déjà connue : son token sera remplacé.'}
        </p>

        {error !== null && (
          <p
            role="alert"
            className="mt-2 rounded-lg px-3 py-2 text-sm"
            style={{
              background: 'color-mix(in oklab, var(--status-critical) 10%, transparent)',
              color: 'var(--status-critical)',
            }}
          >
            {error}
          </p>
        )}
      </div>

      {!compact && (
        <Toggle
          checked={rememberTokens}
          onChange={setRememberTokens}
          label="Se souvenir des tokens"
          hint={
            rememberTokens
              ? 'Conservés en localStorage sur ce poste. Jamais écrits en base ni dans le fichier exporté.'
              : 'Effacés à la fermeture de l’onglet.'
          }
        />
      )}
    </div>
  );
}
