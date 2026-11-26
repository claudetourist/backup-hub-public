/**
 * The few read-only Google Drive calls Backup Hub makes: about, startPageToken, one page of the
 * file list, one page of changes. Everything goes through GoogleHttp (the allowlist).
 */
import type { GoogleAuth } from './auth';
import { ABOUT_URL, CHANGES_URL, FILES_URL, GoogleApiError, START_PAGE_TOKEN_URL, type GoogleHttp } from './googleHttp';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const PAGE_SIZE = 1000;
export const LIST_QUERY = "'me' in owners and trashed = false";
export const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,parents)';
export const CHANGES_FIELDS =
  'nextPageToken,newStartPageToken,changes(fileId,removed,file(name,mimeType,size,md5Checksum,modifiedTime,webViewLink,trashed,parents,ownedByMe))';
export const SHARED_QUERY = "sharedWithMe = true and trashed = false";
export const SHARED_FIELDS = 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,owners(displayName,emailAddress))';
export const ABOUT_FIELDS = 'user(emailAddress),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)';

export interface DriveAbout {
  email: string | null;
  /** null = no limit reported (unlimited). */
  limit: number | null;
  usage: number | null;
  usageInDrive: number | null;
  usageInDriveTrash: number | null;
}

/** An item as Drive describes it (only the fields asked for). */
export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  md5: string | null;
  /** Epoch ms of modifiedTime. */
  mtime: number | null;
  webLink: string | null;
  parent: string | null;
}

/** A file somebody else owns that was shared with the account. */
export interface DriveSharedInfo extends DriveFileInfo {
  ownerName: string | null;
  ownerEmail: string | null;
}

export interface DriveSharedPage {
  files: DriveSharedInfo[];
  nextPageToken: string | null;
}

export interface DriveFilesPage {
  files: DriveFileInfo[];
  nextPageToken: string | null;
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  /** Present unless removed. */
  file: (DriveFileInfo & { trashed: boolean; ownedByMe: boolean | null }) | null;
}

export interface DriveChangesPage {
  changes: DriveChange[];
  nextPageToken: string | null;
  newStartPageToken: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

function time(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function fileInfo(id: string, raw: Record<string, unknown>): DriveFileInfo {
  const parents = Array.isArray(raw['parents']) ? raw['parents'] : [];
  return {
    id,
    name: typeof raw['name'] === 'string' ? raw['name'] : '',
    mimeType: typeof raw['mimeType'] === 'string' ? raw['mimeType'] : '',
    size: num(raw['size']),
    md5: str(raw['md5Checksum']),
    mtime: time(raw['modifiedTime']),
    webLink: str(raw['webViewLink']),
    parent: typeof parents[0] === 'string' ? parents[0] : null,
  };
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class DriveApi {
  constructor(
    private readonly http: GoogleHttp,
    private readonly auth: GoogleAuth,
  ) {}

  /** GET with the account's access token; one new token and one retry after a 401. */
  private async get(placeId: string, url: string, query: Record<string, string | number | boolean>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    for (let attempt = 1; ; attempt += 1) {
      const bearer = await this.auth.accessToken(placeId, signal, attempt > 1);
      try {
        return (await this.http.request({ method: 'GET', url, query, bearer, signal })).json;
      } catch (err) {
        if (attempt === 1 && err instanceof GoogleApiError && err.status === 401) continue;
        throw err;
      }
    }
  }

  async about(placeId: string, signal?: AbortSignal): Promise<DriveAbout> {
    const json = await this.get(placeId, ABOUT_URL, { fields: ABOUT_FIELDS }, signal);
    const quota = obj(json['storageQuota']);
    return {
      email: str(obj(json['user'])['emailAddress']),
      limit: num(quota['limit']),
      usage: num(quota['usage']),
      usageInDrive: num(quota['usageInDrive']),
      usageInDriveTrash: num(quota['usageInDriveTrash']),
    };
  }

  async startPageToken(placeId: string, signal?: AbortSignal): Promise<string> {
    const json = await this.get(placeId, START_PAGE_TOKEN_URL, { fields: 'startPageToken' }, signal);
    const token = str(json['startPageToken']);
    if (!token) throw new GoogleApiError(200, null, 'Google did not give a starting point for changes.');
    return token;
  }

  async listFilesPage(placeId: string, pageToken: string | null, signal?: AbortSignal): Promise<DriveFilesPage> {
    const query: Record<string, string | number | boolean> = { q: LIST_QUERY, pageSize: PAGE_SIZE, fields: LIST_FIELDS };
    if (pageToken) query['pageToken'] = pageToken;
    const json = await this.get(placeId, FILES_URL, query, signal);
    const files: DriveFileInfo[] = [];
    for (const raw of Array.isArray(json['files']) ? json['files'] : []) {
      const o = obj(raw);
      const id = str(o['id']);
      if (id) files.push(fileInfo(id, o));
    }
    return { files, nextPageToken: str(json['nextPageToken']) };
  }

  /** One page of "shared with me" (read only; a plain GET of the files list). */
  async listSharedWithMePage(placeId: string, pageToken: string | null, signal?: AbortSignal): Promise<DriveSharedPage> {
    const query: Record<string, string | number | boolean> = { q: SHARED_QUERY, pageSize: PAGE_SIZE, fields: SHARED_FIELDS };
    if (pageToken) query['pageToken'] = pageToken;
    const json = await this.get(placeId, FILES_URL, query, signal);
    const files: DriveSharedInfo[] = [];
    for (const raw of Array.isArray(json['files']) ? json['files'] : []) {
      const o = obj(raw);
      const id = str(o['id']);
      if (!id) continue;
      const owner = obj(Array.isArray(o['owners']) ? o['owners'][0] : null);
      files.push({ ...fileInfo(id, o), ownerName: str(owner['displayName']), ownerEmail: str(owner['emailAddress']) });
    }
    return { files, nextPageToken: str(json['nextPageToken']) };
  }

  async changesPage(placeId: string, pageToken: string, signal?: AbortSignal): Promise<DriveChangesPage> {
    const json = await this.get(placeId, CHANGES_URL, { pageToken, pageSize: PAGE_SIZE, includeRemoved: true, fields: CHANGES_FIELDS }, signal);
    const changes: DriveChange[] = [];
    for (const raw of Array.isArray(json['changes']) ? json['changes'] : []) {
      const o = obj(raw);
      const fileId = str(o['fileId']);
      if (!fileId) continue;
      const removed = o['removed'] === true;
      const f = o['file'];
      const file =
        !removed && f !== null && typeof f === 'object'
          ? { ...fileInfo(fileId, obj(f)), trashed: obj(f)['trashed'] === true, ownedByMe: typeof obj(f)['ownedByMe'] === 'boolean' ? (obj(f)['ownedByMe'] as boolean) : null }
          : null;
      changes.push({ fileId, removed, file });
    }
    return { changes, nextPageToken: str(json['nextPageToken']), newStartPageToken: str(json['newStartPageToken']) };
  }
}
