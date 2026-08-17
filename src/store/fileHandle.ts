/**
 * Fichier `.json` lié sur le disque, via la File System Access API.
 *
 * Le handle est conservé dans IndexedDB (il est structured-cloneable), ce qui
 * permet de retrouver le même fichier d'une visite à l'autre sans redemander
 * son emplacement. Le navigateur, lui, redemande l'autorisation d'écriture après
 * un redémarrage : c'est volontaire côté plateforme, on la sollicite alors sur
 * un geste utilisateur.
 *
 * Repli automatique sur téléchargement / sélecteur de fichier classique quand
 * l'API est absente (Firefox notamment) : même format, sauvegarde manuelle.
 */

import { readFileHandle, writeFileHandle, clearFileHandle } from './db';
import { toJsonBlob, defaultFileName, type GitStatsFile } from './serialize';

type PermissionState = 'granted' | 'denied' | 'prompt';

interface FileSystemHandleLike {
  name: string;
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  createWritable?: () => Promise<{
    write: (data: Blob | string) => Promise<void>;
    close: () => Promise<void>;
  }>;
  getFile?: () => Promise<File>;
}

interface WindowWithFsa {
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemHandleLike>;
  showOpenFilePicker?: (options?: unknown) => Promise<FileSystemHandleLike[]>;
}

export function isFileSystemAccessSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as WindowWithFsa;
  return typeof w.showSaveFilePicker === 'function' && typeof w.showOpenFilePicker === 'function';
}

const JSON_PICKER_TYPES = [
  { description: 'Données GitStats', accept: { 'application/json': ['.json'] } },
];

export class FileLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileLinkError';
  }
}

/** L'utilisateur choisit où créer/écraser le fichier de données. */
export async function linkFile(host: string): Promise<string> {
  if (!isFileSystemAccessSupported()) {
    throw new FileLinkError(
      "Votre navigateur ne permet pas de lier un fichier (API File System Access absente). Utilisez « Exporter » / « Importer ».",
    );
  }
  const w = window as unknown as WindowWithFsa;
  const handle = await w.showSaveFilePicker!({
    suggestedName: defaultFileName(host),
    types: JSON_PICKER_TYPES,
  });
  await writeFileHandle(handle);
  return handle.name;
}

/** L'utilisateur désigne un fichier existant à relire ET à réutiliser ensuite. */
export async function pickExistingFile(): Promise<{ name: string; text: string }> {
  if (!isFileSystemAccessSupported()) {
    throw new FileLinkError("API File System Access absente : utilisez « Importer ».");
  }
  const w = window as unknown as WindowWithFsa;
  const [handle] = await w.showOpenFilePicker!({ types: JSON_PICKER_TYPES, multiple: false });
  if (!handle?.getFile) throw new FileLinkError('Fichier illisible.');
  const file = await handle.getFile();
  const text = await file.text();
  await writeFileHandle(handle);
  return { name: handle.name, text };
}

export async function getLinkedFileName(): Promise<string | null> {
  const handle = await readFileHandle<FileSystemHandleLike>();
  return handle?.name ?? null;
}

export async function unlinkFile(): Promise<void> {
  await clearFileHandle();
}

/**
 * Vérifie l'autorisation d'écriture.
 * @param interactive `true` uniquement dans un gestionnaire d'évènement utilisateur —
 *   le navigateur refuse la demande d'autorisation hors geste explicite.
 */
export async function ensureWritePermission(interactive: boolean): Promise<boolean> {
  const handle = await readFileHandle<FileSystemHandleLike>();
  if (!handle) return false;
  const state = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
  if (state === 'granted') return true;
  if (!interactive) return false;
  const requested = (await handle.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
  return requested === 'granted';
}

export interface SaveResult {
  saved: boolean;
  reason?: 'no-handle' | 'no-permission' | 'error';
  error?: string;
}

/** Réécrit intégralement le fichier lié. Silencieux s'il n'y en a pas. */
export async function saveToLinkedFile(file: GitStatsFile): Promise<SaveResult> {
  const handle = await readFileHandle<FileSystemHandleLike>();
  if (!handle?.createWritable) return { saved: false, reason: 'no-handle' };

  const state = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
  if (state !== 'granted') return { saved: false, reason: 'no-permission' };

  try {
    const writable = await handle.createWritable();
    await writable.write(toJsonBlob(file));
    await writable.close();
    return { saved: true };
  } catch (error) {
    return { saved: false, reason: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Repli universel : téléchargement classique. */
export function downloadFile(file: GitStatsFile, host: string): void {
  const url = URL.createObjectURL(toJsonBlob(file));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = defaultFileName(host);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Laisser au navigateur le temps de démarrer le téléchargement.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Repli universel : `<input type="file">`. */
export function readFileFromInput(input: HTMLInputElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const file = input.files?.[0];
    if (!file) {
      reject(new FileLinkError('Aucun fichier sélectionné.'));
      return;
    }
    file
      .text()
      .then(resolve)
      .catch(() => reject(new FileLinkError('Fichier illisible.')));
  });
}
