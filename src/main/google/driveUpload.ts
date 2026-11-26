/**
 * The few calls that ADD to Google Drive: find or create a folder, start a resumable upload, send a chunk, ask how
 * much of an upload Google has. Everything goes through GoogleHttp (the allowlist), which refuses anything that
 * could change, trash, delete or download a file.
 */
import type { GoogleAuth } from './auth';
import { FILES_URL, FOLDER_MIME_TYPE, GoogleApiError, UPLOAD_FIELDS, UPLOAD_URL, type GoogleHttp, type GoogleResponse, sessionUriProblem } from './googleHttp';
import { chunkRange, confirmedBytes, quoteDriveString, statusRange, validateSessionUri } from './uploadModel';

/** A chunk may take a while on a slow line. */
const CHUNK_TIMEOUT_MS = 10 * 60 * 1000;

/** What Drive says about a finished upload (only the fields asked for). */
export interface UploadedFile {
  id: string;
  md5: string | null;
  size: number | null;
}

export type ChunkResult = { done: true; file: UploadedFile } | { done: false; confirmed: number };

function asFile(json: Record<string, unknown>): UploadedFile {
  const size = json['size'];
  return {
    id: typeof json['id'] === 'string' ? json['id'] : '',
    md5: typeof json['md5Checksum'] === 'string' ? json['md5Checksum'].toLowerCase() : null,
    size: typeof size === 'string' && /^\d+$/.test(size) ? Number(size) : typeof size === 'number' ? size : null,
  };
}

export class DriveUploader {
  constructor(
    private readonly http: GoogleHttp,
    private readonly auth: GoogleAuth,
  ) {}

  /** A request with the account's access token; one new token and one retry after a 401. */
  private async authed(placeId: string, signal: AbortSignal | undefined, send: (bearer: string) => Promise<GoogleResponse>): Promise<GoogleResponse> {
    for (let attempt = 1; ; attempt += 1) {
      const bearer = await this.auth.accessToken(placeId, signal, attempt > 1);
      try {
        return await send(bearer);
      } catch (err) {
        if (attempt === 1 && err instanceof GoogleApiError && err.status === 401) continue;
        throw err;
      }
    }
  }

  /** The id of a folder the account owns with this name inside this parent ('root' = My Drive), or null. */
  async findFolder(placeId: string, name: string, parentId: string, signal?: AbortSignal): Promise<string | null> {
    const q = `mimeType = '${FOLDER_MIME_TYPE}' and name = ${quoteDriveString(name)} and ${quoteDriveString(parentId)} in parents and trashed = false and 'me' in owners`;
    const { json } = await this.authed(placeId, signal, (bearer) =>
      this.http.request({ method: 'GET', url: FILES_URL, query: { q, pageSize: 10, fields: 'files(id,name)', orderBy: 'createdTime' }, bearer, signal }),
    );
    const first = Array.isArray(json['files']) ? (json['files'][0] as Record<string, unknown> | undefined) : undefined;
    return typeof first?.['id'] === 'string' && first['id'] !== '' ? first['id'] : null;
  }

  /** The files of this account directly inside one folder whose names start with `prefix` (read only; at most 100). */
  async listChildren(placeId: string, parentId: string, prefix: string, signal?: AbortSignal): Promise<{ id: string; name: string; size: number | null }[]> {
    const q = `${quoteDriveString(parentId)} in parents and trashed = false and 'me' in owners and name contains ${quoteDriveString(prefix)}`;
    const { json } = await this.authed(placeId, signal, (bearer) =>
      this.http.request({ method: 'GET', url: FILES_URL, query: { q, pageSize: 100, fields: 'files(id,name,size)' }, bearer, signal }),
    );
    const files = Array.isArray(json['files']) ? (json['files'] as Record<string, unknown>[]) : [];
    return files
      .filter((f) => typeof f['name'] === 'string' && f['name'].startsWith(prefix))
      .map((f) => ({ id: typeof f['id'] === 'string' ? f['id'] : '', name: f['name'] as string, size: asFile(f).size }));
  }

  /** Makes a folder (never anything else: the allowlist refuses any other type). Returns its id. */
  async createFolder(placeId: string, name: string, parentId: string, signal?: AbortSignal): Promise<string> {
    const { json } = await this.authed(placeId, signal, (bearer) =>
      this.http.request({ method: 'POST', url: FILES_URL, query: { fields: 'id' }, json: { name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] }, bearer, signal }),
    );
    const id = json['id'];
    if (typeof id !== 'string' || id === '') throw new GoogleApiError(200, null, 'Google did not return the new folder.');
    return id;
  }

  /** Starts a resumable upload of `size` bytes; returns the session address (checked: exactly the allowed shape). */
  async startSession(placeId: string, name: string, parentId: string, size: number, signal?: AbortSignal): Promise<string> {
    const response = await this.authed(placeId, signal, (bearer) =>
      this.http.request({ method: 'POST', url: UPLOAD_URL, query: { uploadType: 'resumable', fields: UPLOAD_FIELDS }, json: { name, parents: [parentId] }, uploadLength: size, bearer, signal }),
    );
    const uri = validateSessionUri(response.headers.location);
    if (uri === null) throw new GoogleApiError(response.status, 'bad_session_address', `Google gave an upload address that Backup Hub does not accept (${sessionUriProblem(response.headers.location)}), so nothing was sent.`);
    return uri;
  }

  private result(response: GoogleResponse): ChunkResult {
    if (response.status === 308) {
      const confirmed = confirmedBytes(response.headers.range);
      if (confirmed === null) throw new GoogleApiError(308, 'bad_range', 'Google said how far the upload got in a way that could not be read.');
      return { done: false, confirmed };
    }
    return { done: true, file: asFile(response.json) };
  }

  /** Sends one chunk at `offset`. One try only: after any failure the caller asks `status` before sending again. */
  async putChunk(placeId: string, sessionUri: string, bytes: Uint8Array<ArrayBuffer>, offset: number, total: number, signal?: AbortSignal): Promise<ChunkResult> {
    const response = await this.authed(placeId, signal, (bearer) =>
      this.http.request({ method: 'PUT', url: sessionUri, bytes, contentRange: chunkRange(offset, bytes.length, total), acceptStatuses: [308], noRetry: true, timeoutMs: CHUNK_TIMEOUT_MS, bearer, signal }),
    );
    return this.result(response);
  }

  /** Asks Google how much of the upload it holds (a finished upload answers with the file). */
  async status(placeId: string, sessionUri: string, total: number, signal?: AbortSignal): Promise<ChunkResult> {
    const response = await this.authed(placeId, signal, (bearer) =>
      this.http.request({ method: 'PUT', url: sessionUri, contentRange: statusRange(total), acceptStatuses: [308], noRetry: true, bearer, signal }),
    );
    return this.result(response);
  }
}
