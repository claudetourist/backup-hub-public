import path from 'node:path';
import { looksLikeEmail, type OpenInDriveResult, type ShowInFolderResult } from '../../shared/search';

export { looksLikeEmail };
import type { Db } from '../db';
import { isInsideOrSame } from '../listing/skipRules';

/**
 * The only two things Search can do, and neither changes anything:
 * - "Show in folder": opens the folder in Explorer with the file selected, but only for a file of a
 *   place that is connected right now, whose path lies inside a folder that place lists, and that
 *   still exists.
 * - "Open in Drive": opens the file's own link in the browser, but only an https address on
 *   drive.google.com or docs.google.com.
 * The window sends a file id only; the path and the link are read from the database here.
 */

export interface SearchActionDeps {
  db: Db;
  /** The folder a connected place is at right now ('' for the laptop, whose paths are absolute); null when it is not connected or has no folder. */
  baseOf: (place: { id: string; kind: string; label: string }) => string | null;
  /** Folders the place lists (laptop: absolute; others: relative to the place, '' = all of it). */
  rootsOf: (placeId: string) => string[];
  exists: (absolutePath: string) => boolean;
  showItem: (absolutePath: string) => void;
  openExternal: (url: string) => Promise<void>;
}

interface FileRow {
  rel_path: string;
  web_link: string | null;
  gone_at: number | null;
  place_id: string;
  kind: string;
  label: string;
}

/** The only hosts "Open in Drive" will open. */
export const DRIVE_HOSTS: readonly string[] = ['drive.google.com', 'docs.google.com'];

/** True for an https address on exactly one of the Drive hosts (no sign-in part, no odd port). */
export function isDriveLink(link: unknown): link is string {
  if (typeof link !== 'string' || link.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && DRIVE_HOSTS.includes(url.hostname) && url.username === '' && url.password === '' && url.port === '';
}

/**
 * The Drive link with `authuser=<email>` so Google opens the file as that account (or asks to sign in to it).
 * Any `authuser` the link already has is replaced; a link or label that does not qualify comes back unchanged.
 */
export function withAuthUser(link: string, label: unknown): string {
  if (!isDriveLink(link) || !looksLikeEmail(label)) return link;
  const url = new URL(link);
  url.searchParams.set('authuser', label);
  return url.toString();
}

export class SearchActions {
  constructor(private readonly deps: SearchActionDeps) {}

  private row(fileId: unknown): FileRow | null {
    if (typeof fileId !== 'number' || !Number.isInteger(fileId) || fileId <= 0) return null;
    return (
      (this.deps.db
        .prepare(
          `SELECT f.rel_path, f.web_link, f.gone_at, f.place_id, p.kind, p.label
             FROM files f JOIN places p ON p.id = f.place_id WHERE f.id = ?`,
        )
        .get(fileId) as FileRow | undefined) ?? null
    );
  }

  /** The absolute path of a file, or a plain reason it may not be shown. */
  locate(fileId: unknown): { ok: true; absolutePath: string } | { ok: false; message: string } {
    const row = this.row(fileId);
    if (!row || row.gone_at !== null) return { ok: false, message: 'That file is no longer on the list.' };
    if (row.kind !== 'laptop' && row.kind !== 'drive' && row.kind !== 'onedrive') {
      return { ok: false, message: 'This copy is not on a drive of this computer, so there is no folder to open.' };
    }
    const base = this.deps.baseOf({ id: row.place_id, kind: row.kind, label: row.label });
    if (base === null) return { ok: false, message: `${row.label} is not connected right now. Plug it in or sign in to it, then try again.` };
    const rel = row.rel_path.split('/').join(path.sep);
    if (rel.split(path.sep).includes('..')) return { ok: false, message: 'That path is not a normal file path, so it was not opened.' };
    const absolutePath = row.kind === 'laptop' ? rel : path.join(base, rel);
    if (!path.isAbsolute(absolutePath)) return { ok: false, message: 'That path is not a full file path, so it was not opened.' };
    const roots = this.deps.rootsOf(row.place_id);
    const inside = roots.some((root) => {
      const rootPath = row.kind === 'laptop' ? root : root === '' ? base : path.join(base, root.split('/').join(path.sep));
      return path.isAbsolute(rootPath) && isInsideOrSame(absolutePath, rootPath);
    });
    if (!inside) return { ok: false, message: 'That file is outside the folders Backup Hub lists, so it was not opened.' };
    if (!this.deps.exists(absolutePath)) return { ok: false, message: 'That file is not there any more. It may have been moved; check the place again to refresh.' };
    return { ok: true, absolutePath };
  }

  showInFolder(fileId: unknown): ShowInFolderResult {
    const found = this.locate(fileId);
    if (!found.ok) return found;
    try {
      this.deps.showItem(found.absolutePath);
      return { ok: true };
    } catch {
      return { ok: false, message: 'Windows could not open that folder.' };
    }
  }

  async openInDrive(fileId: unknown): Promise<OpenInDriveResult> {
    const row = this.row(fileId);
    if (!row || row.gone_at !== null) return { ok: false, message: 'That file is no longer on the list.' };
    if (row.kind !== 'gdrive') return { ok: false, message: 'This copy is not in Google Drive.' };
    if (!isDriveLink(row.web_link)) return { ok: false, message: 'There is no safe link to open for this file.' };
    try {
      await this.deps.openExternal(withAuthUser(row.web_link, row.label));
      return { ok: true };
    } catch {
      return { ok: false, message: 'The browser could not be opened.' };
    }
  }
}
