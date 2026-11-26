/**
 * A stand-in for Google used by the tests: a fake fetch that answers the few allowed requests from
 * in-memory accounts. No test ever reaches the network.
 */
import { createHash } from 'node:crypto';
import type { FetchFn } from './googleHttp';

export interface FakeItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime: string;
  parents?: string[];
  trashed: boolean;
  ownedByMe: boolean;
}

export const FOLDER = 'application/vnd.google-apps.folder';

export class FakeAccount {
  readonly items = new Map<string, FakeItem>();
  readonly log: { fileId: string; removed: boolean }[] = [];
  revoked = false;
  quota = { limit: '16106127360', usage: '5000', usageInDrive: '3000', usageInDriveTrash: '100' };

  constructor(
    readonly email: string,
    readonly refreshToken: string,
  ) {}

  put(partial: Partial<FakeItem> & { id: string }): FakeItem {
    const old = this.items.get(partial.id);
    const item: FakeItem = {
      name: '',
      mimeType: 'text/plain',
      modifiedTime: '2026-10-01T10:00:00.000Z',
      trashed: false,
      ownedByMe: true,
      parents: ['ROOT'],
      ...old,
      ...partial,
    };
    this.items.set(item.id, item);
    this.log.push({ fileId: item.id, removed: false });
    return item;
  }

  folder(id: string, name: string, parent = 'ROOT'): FakeItem {
    return this.put({ id, name, mimeType: FOLDER, parents: [parent] });
  }

  file(id: string, name: string, parent = 'ROOT', extra: Partial<FakeItem> = {}): FakeItem {
    return this.put({ id, name, parents: [parent], size: '10', md5Checksum: `md5-${id}`, ...extra });
  }

  remove(id: string): void {
    this.items.delete(id);
    this.log.push({ fileId: id, removed: true });
  }

  /** Items that existed before the test started are "already in the log": call after seeding. */
  get token(): string {
    return `c${this.log.length}`;
  }
}

export interface FakeCall {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, string>;
  /** The JSON body, when the request had one. */
  json: Record<string, unknown> | null;
  /** The bytes of a chunk, when the request had any. */
  bytes: Uint8Array | null;
  headers: Record<string, string>;
  redirect: string | undefined;
  hasAuth: boolean;
  account: string | null;
}

/** An upload in progress on the fake. */
export interface FakeSession {
  id: string;
  account: FakeAccount;
  name: string;
  parent: string;
  total: number;
  startedAt: number;
  chunks: Buffer[];
  received: number;
  /** The query of the start request (so a test can see `fields`). */
  startQuery: Record<string, string>;
  doneItem: FakeItem | null;
}

/** How a test makes a chunk go wrong: 'lose' keeps the chunk but answers 503, 'fail' answers 503 without keeping it, 'network' never answers. */
export type PutFault = 'lose' | 'fail' | 'network' | null;

type Override = (call: FakeCall) => Response | null;

export class FakeGoogle {
  readonly accounts: FakeAccount[] = [];
  readonly calls: FakeCall[] = [];
  /** Items per page, whatever the caller asks for. */
  pageSize = 2;
  /** When set, called first for each request; return a Response to replace the normal answer. */
  override: Override | null = null;
  /** When set, every request takes this many milliseconds (real time) and is answered only after that; an aborted request stops waiting. */
  delayMs: ((call: FakeCall) => number) | null = null;
  /** When true, every access token handed out so far stops working (401). */
  private generation = 0;
  private issued = new Map<string, { account: FakeAccount; generation: number }>();
  private counter = 0;
  /** When set, any changes request answers 410. */
  changesGone = false;
  /** When set, changes requests answer a next page token equal to the requested one. */
  stallChanges = false;

  // ---- Uploads ----
  readonly sessions = new Map<string, FakeSession>();
  /** Decides, for the nth chunk request (1 = the first, status questions not counted), whether it goes wrong. */
  putFault: ((n: number, call: FakeCall) => PutFault) | null = null;
  /** The longest part of a chunk the fake keeps (as Google keeps whole 256 KiB blocks); null = all of it. */
  keepAtMost: number | null = null;
  /** Makes the finished file report this md5 instead of the real one. */
  corruptMd5 = false;
  /** The final upload answer carries only the id (as if Google ignored `fields`); the md5 is then only in a file lookup. */
  bareFinalAnswer = false;
  /** Accounts whose uploads are refused with storageQuotaExceeded (at the start, or at the first chunk). */
  fullAtStart = new Set<string>();
  fullAtChunk = new Set<string>();
  /** Sessions the fake forgets (404) after this many seconds of its own clock; a test just calls `forgetSession`. */
  private chunkCount = 0;
  private folderCounter = 0;
  private fileCounter = 0;
  now = (): number => Date.now();

  forgetSession(id: string): void {
    this.sessions.delete(id);
  }

  /** Files an account holds with this name (uploaded or seeded). */
  filesNamed(account: FakeAccount, name: string): FakeItem[] {
    return [...account.items.values()].filter((i) => i.name === name && i.mimeType !== FOLDER);
  }

  /** The content a finished upload stored, by file id. */
  readonly stored = new Map<string, Buffer>();

  add(account: FakeAccount): FakeAccount {
    this.accounts.push(account);
    return account;
  }

  expireTokens(): void {
    this.generation += 1;
  }

  count(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }

  readonly fetchFn: FetchFn = (input, init) => {
    const url = new URL(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const bearer = headers['Authorization']?.replace(/^Bearer /, '') ?? null;
    const body: Record<string, string> = {};
    let json: Record<string, unknown> | null = null;
    let bytes: Uint8Array | null = null;
    if (typeof init.body === 'string') {
      if ((headers['Content-Type'] ?? '').startsWith('application/json')) json = JSON.parse(init.body) as Record<string, unknown>;
      else for (const [k, v] of new URLSearchParams(init.body)) body[k] = v;
    } else if (init.body instanceof Uint8Array) bytes = init.body;
    const issued = bearer ? this.issued.get(bearer) : undefined;
    const call: FakeCall = {
      method: init.method ?? 'GET',
      host: url.host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      json,
      bytes,
      headers,
      redirect: init.redirect,
      hasAuth: bearer !== null,
      account: issued?.account.email ?? null,
    };
    this.calls.push(call);
    const replaced = this.override?.(call);
    if (replaced) return Promise.resolve(replaced);
    const answer = (): Promise<Response> => {
      try {
        return Promise.resolve(this.answer(call, bearer));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const wait = this.delayMs?.(call) ?? 0;
    if (wait <= 0) return answer();
    const signal = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        void answer().then(resolve, reject);
      }, wait);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  private json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  private answer(call: FakeCall, bearer: string | null): Response {
    if (call.path === '/token') {
      const account = this.accounts.find((a) => a.refreshToken === call.body['refresh_token']);
      if (call.body['grant_type'] === 'authorization_code') return this.json(400, { error: 'invalid_grant' });
      if (!account || account.revoked) return this.json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      this.counter += 1;
      const token = `ya29.fake-${this.counter}`;
      this.issued.set(token, { account, generation: this.generation });
      return this.json(200, { access_token: token, expires_in: 3600, token_type: 'Bearer' });
    }
    const issued = bearer ? this.issued.get(bearer) : undefined;
    if (!issued || issued.generation !== this.generation) return this.json(401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
    const account = issued.account;
    switch (call.path) {
      case '/drive/v3/about':
        return this.json(200, { user: { emailAddress: account.email }, storageQuota: account.quota });
      case '/drive/v3/changes/startPageToken':
        return this.json(200, { startPageToken: account.token });
      case '/drive/v3/files':
        return call.method === 'POST' ? this.newFolder(account, call) : this.files(account, call);
      case '/upload/drive/v3/files':
        return call.method === 'POST' ? this.startUpload(account, call) : this.chunk(account, call);
      case '/drive/v3/changes':
        return this.changes(account, call);
      default:
        return this.json(404, { error: { code: 404, message: 'not found' } });
    }
  }

  private newFolder(account: FakeAccount, call: FakeCall): Response {
    if (call.json?.['mimeType'] !== FOLDER) return this.json(400, { error: { code: 400, message: 'only folders here' } });
    this.folderCounter += 1;
    const parent = String((call.json['parents'] as string[])[0]);
    const item = account.folder(`fold-${this.folderCounter}`, String(call.json['name']), parent === 'root' ? 'ROOT' : parent);
    return this.json(200, { id: item.id });
  }

  private folderLookup(account: FakeAccount, q: string): Response | null {
    const m = /^mimeType = 'application\/vnd\.google-apps\.folder' and name = '((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents and trashed = false and 'me' in owners$/.exec(q);
    if (!m) return null;
    const name = m[1]!.replace(/\\(.)/g, '$1');
    const parent = m[2]!.replace(/\\(.)/g, '$1') === 'root' ? 'ROOT' : m[2]!.replace(/\\(.)/g, '$1');
    const found = [...account.items.values()].filter((i) => i.mimeType === FOLDER && i.name === name && i.parents?.[0] === parent && !i.trashed && i.ownedByMe);
    return this.json(200, { files: found.map((i) => ({ id: i.id, name: i.name })) });
  }

  private startUpload(account: FakeAccount, call: FakeCall): Response {
    if (this.fullAtStart.has(account.email)) return this.quotaFull();
    if (call.query['uploadType'] !== 'resumable' || !call.json) return this.json(400, { error: { code: 400, message: 'resumable only' } });
    const total = Number(call.headers['X-Upload-Content-Length']);
    this.fileCounter += 1;
    const id = `up-${this.fileCounter}-${Math.abs(Math.floor(this.now()) % 100000)}`;
    const parent = String((call.json['parents'] as string[])[0]);
    this.sessions.set(id, { id, account, name: String(call.json['name']), parent: parent === 'root' ? 'ROOT' : parent, total, startedAt: this.now(), chunks: [], received: 0, startQuery: call.query, doneItem: null });
    return new Response('{}', { status: 200, headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` } });
  }

  private quotaFull(): Response {
    return this.json(403, { error: { code: 403, message: 'The user storage quota has been exceeded.', errors: [{ reason: 'storageQuotaExceeded' }] } });
  }

  private chunk(account: FakeAccount, call: FakeCall): Response {
    const session = this.sessions.get(call.query['upload_id'] ?? '');
    if (!session || session.account !== account) return this.json(404, { error: { code: 404, message: 'Not Found' } });
    const range = call.headers['Content-Range'] ?? '';
    const status = new RegExp('^bytes \\*/(\\d+)$').exec(range);
    const answerStatus = (): Response => {
      if (session.doneItem) return this.json(200, this.finalBody(session));
      return new Response('', { status: 308, headers: session.received > 0 ? { Range: `bytes=0-${session.received - 1}` } : {} });
    };
    if (status) return answerStatus();
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m || !call.bytes) return this.json(400, { error: { code: 400, message: 'bad chunk' } });
    this.chunkCount += 1;
    const fault = this.putFault?.(this.chunkCount, call) ?? null;
    if (fault === 'network') throw new TypeError('fetch failed');
    if (fault === 'fail') return this.json(503, { error: { code: 503, message: 'Backend Error' } });
    if (this.fullAtChunk.has(account.email)) return this.quotaFull();
    const start = Number(m[1]);
    if (start > session.received) return this.json(400, { error: { code: 400, message: 'gap' } });
    let data = Buffer.from(call.bytes).subarray(session.received - start);
    if (this.keepAtMost !== null) data = data.subarray(0, this.keepAtMost);
    session.chunks.push(Buffer.from(data));
    session.received += data.length;
    if (fault === 'lose') return this.json(503, { error: { code: 503, message: 'Backend Error' } });
    if (session.received >= session.total) {
      this.finish(session);
      return this.json(200, this.finalBody(session));
    }
    return answerStatus();
  }

  private finish(session: FakeSession): void {
    const content = Buffer.concat(session.chunks);
    const real = createHash('md5').update(content).digest('hex');
    this.fileCounter += 1;
    const id = `file-${this.fileCounter}`;
    session.doneItem = session.account.file(id, session.name, session.parent, { size: String(content.length), md5Checksum: this.corruptMd5 ? 'f'.repeat(32) : real });
    this.stored.set(id, content);
    const used = Number(session.account.quota.usage) + content.length;
    session.account.quota = { ...session.account.quota, usage: String(used), usageInDrive: String(Number(session.account.quota.usageInDrive) + content.length) };
  }

  private finalBody(session: FakeSession): Record<string, unknown> {
    const item = session.doneItem!;
    return this.bareFinalAnswer ? { id: item.id } : { id: item.id, md5Checksum: item.md5Checksum, size: item.size };
  }

  /** "name = '...' and '...' in parents and trashed = false and 'me' in owners": the uploader's check of a finished file. */
  private fileLookup(account: FakeAccount, q: string): Response | null {
    const m = /^name = '((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents and trashed = false and 'me' in owners$/.exec(q);
    if (!m) return null;
    const name = m[1]!.replace(/\\(.)/g, '$1');
    const parent = m[2]!.replace(/\\(.)/g, '$1');
    const found = [...account.items.values()].filter((i) => i.mimeType !== FOLDER && i.name === name && i.parents?.[0] === parent && !i.trashed && i.ownedByMe);
    return this.json(200, { files: found.map((i) => ({ id: i.id, md5Checksum: i.md5Checksum, size: i.size })) });
  }

  private files(account: FakeAccount, call: FakeCall): Response {
    const folder = this.folderLookup(account, call.query['q'] ?? '');
    if (folder) return folder;
    const lookup = this.fileLookup(account, call.query['q'] ?? '');
    if (lookup) return lookup;
    if (call.query['q'] !== "'me' in owners and trashed = false") return this.json(400, { error: { code: 400, message: 'unexpected query' } });
    const all = [...account.items.values()].filter((i) => i.ownedByMe && !i.trashed).toSorted((a, b) => (a.id < b.id ? -1 : 1));
    const offset = call.query['pageToken'] ? Number(call.query['pageToken'].slice(1)) : 0;
    const page = all.slice(offset, offset + this.pageSize);
    const out: Record<string, unknown> = {
      files: page.map((i) => ({ id: i.id, name: i.name, mimeType: i.mimeType, size: i.size, md5Checksum: i.md5Checksum, modifiedTime: i.modifiedTime, webViewLink: `https://drive.example/${i.id}`, parents: i.parents })),
    };
    if (offset + this.pageSize < all.length) out['nextPageToken'] = `p${offset + this.pageSize}`;
    return this.json(200, out);
  }

  private changes(account: FakeAccount, call: FakeCall): Response {
    if (this.changesGone) return this.json(410, { error: { code: 410, message: 'Token expired', errors: [{ reason: 'pageTokenExpired' }] } });
    const requested = call.query['pageToken'] ?? '';
    if (this.stallChanges) return this.json(200, { nextPageToken: requested, changes: [] });
    const from = Number(requested.slice(1));
    const slice = account.log.slice(from, from + this.pageSize);
    const changes = slice.map((c) => {
      const item = account.items.get(c.fileId);
      return c.removed || !item
        ? { fileId: c.fileId, removed: true }
        : {
            fileId: c.fileId,
            removed: false,
            file: { name: item.name, mimeType: item.mimeType, size: item.size, md5Checksum: item.md5Checksum, modifiedTime: item.modifiedTime, webViewLink: `https://drive.example/${item.id}`, trashed: item.trashed, parents: item.parents, ownedByMe: item.ownedByMe },
          };
    });
    const end = from + this.pageSize;
    return this.json(200, end < account.log.length ? { nextPageToken: `c${end}`, changes } : { newStartPageToken: `c${account.log.length}`, changes });
  }
}
