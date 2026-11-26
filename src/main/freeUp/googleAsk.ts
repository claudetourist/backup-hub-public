/**
 * Asks Google, right now, what it holds for one file it was given earlier: its MD5 and size. Read only: the one allowed lookup by name and
 * parent folder (the same shape as the upload's "is it already there" question), then the answer with the file's own id is picked. Free up
 * phone space uses this because the index of Google's files can be a day old; a copy counts only when Google says so again now.
 */
import { ABOUT_URL, FILES_URL, GoogleApiError, NetworkError, RequestAborted, type GoogleHttp } from '../google/googleHttp';
import type { GoogleAuth } from '../google/auth';

export type GoogleAnswer = { kind: 'found'; md5: string | null; size: number | null } | { kind: 'missing' } | { kind: 'unreachable'; reason: string };

export interface GoogleFileRef {
  placeId: string;
  fileId: string;
  name: string;
  /** The folder the file sits in (from the last refresh); null when it is not known. */
  parentId: string | null;
}

/** What Free up phone space needs from Google. Tests pass a fake that sits on the fake Google. */
export interface GoogleAsk {
  /** True when this account answers at all (a sign-in that works and a network). */
  reachable(placeId: string, signal?: AbortSignal): Promise<boolean>;
  ask(ref: GoogleFileRef, signal?: AbortSignal): Promise<GoogleAnswer>;
}

const quote = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export class DriveGoogleAsk implements GoogleAsk {
  constructor(
    private readonly http: GoogleHttp,
    private readonly auth: GoogleAuth,
  ) {}

  private async get(placeId: string, url: string, query: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
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

  async reachable(placeId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.get(placeId, ABOUT_URL, { fields: 'user(emailAddress)' }, signal);
      return true;
    } catch (err) {
      if (err instanceof RequestAborted || signal?.aborted) throw err;
      return false;
    }
  }

  async ask(ref: GoogleFileRef, signal?: AbortSignal): Promise<GoogleAnswer> {
    if (ref.parentId === null) return { kind: 'missing' };
    try {
      const json = await this.get(ref.placeId, FILES_URL, { q: `name = '${quote(ref.name)}' and '${quote(ref.parentId)}' in parents and trashed = false and 'me' in owners`, fields: 'files(id,md5Checksum,size)' }, signal);
      const files = Array.isArray(json['files']) ? (json['files'] as Record<string, unknown>[]) : [];
      const hit = files.find((f) => f['id'] === ref.fileId);
      if (!hit) return { kind: 'missing' };
      const md5 = typeof hit['md5Checksum'] === 'string' ? hit['md5Checksum'].toLowerCase() : null;
      const size = typeof hit['size'] === 'string' && /^\d+$/.test(hit['size']) ? Number(hit['size']) : typeof hit['size'] === 'number' ? hit['size'] : null;
      return { kind: 'found', md5, size };
    } catch (err) {
      if (err instanceof RequestAborted || signal?.aborted) throw err;
      return { kind: 'unreachable', reason: err instanceof NetworkError || err instanceof GoogleApiError ? err.message.slice(0, 120) : 'Google did not answer.' };
    }
  }
}
