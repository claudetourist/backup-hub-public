/**
 * The ONLY code in Backup Hub that talks to the network.
 *
 * Backup Hub reads from Google and only ever ADDS to it. Before anything is sent, the method, address
 * and (for the writes) the body are checked against a short list of allowed requests; anything else
 * throws and nothing is sent:
 *   POST  https://oauth2.googleapis.com/token            (sign-in refresh and the sign-in code exchange)
 *   POST  https://oauth2.googleapis.com/revoke           ("Sign out": the form carries only the token to give back)
 *   GET   https://www.googleapis.com/drive/v3/about
 *   GET   https://www.googleapis.com/drive/v3/files      (the list only: never one file, never a download)
 *   GET   https://www.googleapis.com/drive/v3/changes
 *   GET   https://www.googleapis.com/drive/v3/changes/startPageToken
 *   GET   https://openidconnect.googleapis.com/v1/userinfo
 *   POST  https://www.googleapis.com/drive/v3/files      (a new FOLDER only: a JSON body of exactly name, parents and the folder type)
 *   POST  https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable  (starts an upload: a JSON body of exactly name and parents)
 *   PUT   the upload session address Google returned (https, www.googleapis.com, that same path, an upload_id, nothing else)
 *   GET   https://www.googleapis.com/drive/v3/files/<id>?alt=media  (ONE file's bytes, only through `openDownload`, for "Get files back")
 * There is no DELETE, no PATCH, no trash and no other host. A download is only possible through `openDownload`: `request` refuses it. Redirects are never followed.
 * A test scans the source and fails if any other file makes network calls.
 */
import { redact } from './redact';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about';
export const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
export const CHANGES_URL = 'https://www.googleapis.com/drive/v3/changes';
export const START_PAGE_TOKEN_URL = 'https://www.googleapis.com/drive/v3/changes/startPageToken';
export const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
/** What an upload answers with (and the only `fields` value the start of an upload may carry). */
export const UPLOAD_FIELDS = 'id,md5Checksum,size';
/** A Drive file id in an address (letters, digits, "-" and "_"). */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{6,128}$/;

type Method = 'GET' | 'POST' | 'PUT';

interface AllowedRequest {
  method: Method;
  /** Query parameters the request may carry. */
  params: readonly string[];
  /** Extra rules for the query; throws RequestNotAllowedError. */
  query?: (params: URLSearchParams) => void;
  /** Rule for the JSON body. A request without a `body` rule may not carry a JSON body at all. */
  body?: (body: unknown) => void;
}

/** Thrown before anything is sent when a request is not on the list. */
export class RequestNotAllowedError extends Error {
  constructor(detail: string) {
    super(`Backup Hub only adds to Google and never changes or removes anything there, so this request was not sent (${detail}).`);
    this.name = 'RequestNotAllowedError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const SESSION_ID = /^[A-Za-z0-9_.~-]{1,2048}$/;
/** Google's own session key in an upload address: printable text only (no spaces or control characters). */
const SESSION_KEY = /^[\x21-\x7e]{1,4096}$/;

/** A JSON body with exactly these keys: a name, one parent, and (for a folder, only then) the folder type. */
function metadataBody(folder: boolean): (body: unknown) => void {
  return (body) => {
    if (!isObject(body)) throw new RequestNotAllowedError('the body must be JSON');
    const keys = Object.keys(body).toSorted();
    if (keys.join(',') !== (folder ? 'mimeType,name,parents' : 'name,parents')) throw new RequestNotAllowedError('the body has options that are not allowed');
    if (folder && body['mimeType'] !== FOLDER_MIME_TYPE) throw new RequestNotAllowedError('only a folder may be created');
    const parents = body['parents'];
    if (typeof body['name'] !== 'string' || body['name'] === '' || !Array.isArray(parents) || parents.length !== 1 || typeof parents[0] !== 'string' || parents[0] === '') {
      throw new RequestNotAllowedError('the name or the parent folder is not valid');
    }
  };
}

function singleParam(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  if (all.length > 1) throw new RequestNotAllowedError(`the option "${name}" is given twice`);
  return all[0] ?? null;
}

/** The complete list. Key = scheme, host and path; a path may allow more than one method. */
const ALLOWED: ReadonlyMap<string, readonly AllowedRequest[]> = new Map<string, readonly AllowedRequest[]>([
  [TOKEN_URL, [{ method: 'POST', params: [] }]],
  [REVOKE_URL, [{ method: 'POST', params: [] }]],
  [ABOUT_URL, [{ method: 'GET', params: ['fields'] }]],
  [
    FILES_URL,
    [
      { method: 'GET', params: ['q', 'pageSize', 'pageToken', 'fields', 'orderBy', 'spaces', 'corpora'] },
      { method: 'POST', params: ['fields'], body: metadataBody(true) },
    ],
  ],
  [CHANGES_URL, [{ method: 'GET', params: ['pageToken', 'pageSize', 'fields', 'includeRemoved', 'spaces', 'restrictToMyDrive'] }]],
  [START_PAGE_TOKEN_URL, [{ method: 'GET', params: ['fields'] }]],
  [USERINFO_URL, [{ method: 'GET', params: [] }]],
  [
    UPLOAD_URL,
    [
      {
        method: 'POST',
        params: ['uploadType', 'fields'],
        body: metadataBody(false),
        query: (p) => {
          if (singleParam(p, 'uploadType') !== 'resumable') throw new RequestNotAllowedError('only a resumable upload may be started');
          const fields = singleParam(p, 'fields');
          if (fields !== null && fields !== UPLOAD_FIELDS) throw new RequestNotAllowedError('that answer option is not allowed');
        },
      },
      {
        method: 'PUT',
        // Google may repeat the options of the start in the session address, so `fields` is allowed with its one value.
        // Google also adds `session_crd`, its own key for the session (seen on real uploads, 26 Nov 2026): one value, plain text.
        params: ['uploadType', 'upload_id', 'fields', 'session_crd'],
        query: (p) => {
          const id = singleParam(p, 'upload_id');
          if (id === null || !SESSION_ID.test(id)) throw new RequestNotAllowedError('the upload address has no valid upload_id');
          const type = singleParam(p, 'uploadType');
          if (type !== null && type !== 'resumable') throw new RequestNotAllowedError('only a resumable upload may be continued');
          const fields = singleParam(p, 'fields');
          if (fields !== null && fields !== UPLOAD_FIELDS) throw new RequestNotAllowedError('that answer option is not allowed');
          if (p.has('session_crd')) {
            const crd = singleParam(p, 'session_crd');
            if (crd === null || !SESSION_KEY.test(crd)) throw new RequestNotAllowedError('the upload address has an unexpected session key');
          }
        },
      },
    ],
  ],
]);

/**
 * Throws RequestNotAllowedError unless this method and address are on the list.
 * Exact scheme, host and path; only the listed query parameters; `alt` (downloads) is only allowed with `options.download`.
 * A write must also carry the one kind of JSON body that is allowed for it.
 */
export function assertAllowed(method: string, rawUrl: string, jsonBody?: unknown, options: { download?: boolean } = {}): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RequestNotAllowedError('the address is not valid');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') {
    throw new RequestNotAllowedError('the address is not an allowed one');
  }
  if (options.download === true) {
    // One file's bytes: GET, the files address plus one Drive id, and exactly "alt=media" (nothing else). Only `openDownload` asks for this.
    const id = url.pathname.startsWith('/drive/v3/files/') ? url.pathname.slice('/drive/v3/files/'.length) : '';
    const optionNames = [...url.searchParams.keys()];
    if (method !== 'GET' || url.host !== 'www.googleapis.com' || !DRIVE_FILE_ID.test(id) || optionNames.length !== 1 || url.searchParams.getAll('alt').join() !== 'media' || jsonBody !== undefined) {
      throw new RequestNotAllowedError('that is not a plain download of one file');
    }
    return;
  }
  const key = `${url.protocol}//${url.host}${url.pathname}`;
  const rules = ALLOWED.get(key);
  if (!rules) throw new RequestNotAllowedError('that address is not on the list');
  const rule = rules.find((r) => r.method === method);
  if (!rule) throw new RequestNotAllowedError(`${method} is not allowed there`);
  for (const name of url.searchParams.keys()) {
    if (!rule.params.includes(name)) throw new RequestNotAllowedError(`the option "${name}" is not allowed`);
  }
  rule.query?.(url.searchParams);
  if (rule.body) {
    if (jsonBody === undefined) throw new RequestNotAllowedError('a body is needed there');
    rule.body(jsonBody);
  } else if (jsonBody !== undefined) {
    throw new RequestNotAllowedError('no body is allowed there');
  }
}

/**
 * The address Google gave for continuing an upload, or null when it is not exactly the allowed shape:
 * https, www.googleapis.com, no port, no user name, the upload path, an upload_id, nothing else.
 */
export function parseSessionUri(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  try {
    assertAllowed('PUT', raw);
    return new URL(raw).toString();
  } catch {
    return null;
  }
}

/** Why an upload address was refused, for the report (the upload_id and any other values are never shown, only the shape). */
export function sessionUriProblem(raw: string | null): string {
  if (raw === null || raw === '') return 'Google gave no upload address';
  try {
    assertAllowed('PUT', raw);
    return 'accepted';
  } catch (err) {
    let shape = 'not an address';
    try {
      const u = new URL(raw);
      shape = `${u.protocol}//${u.host}${u.pathname} with options ${[...u.searchParams.keys()].join(', ') || 'none'}`;
    } catch {
      // keep "not an address"
    }
    return `${(err as Error).message}; the address was ${shape}`;
  }
}

/** Google answered with an error status. */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    /** Google's short reason ("rateLimitExceeded", "invalid_grant"), if it gave one. */
    readonly reason: string | null,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** The request never got an answer (no internet, DNS, connection reset, timeout). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** The user stopped the job while a request or a wait was under way. */
export class RequestAborted extends Error {
  constructor() {
    super('The request was stopped');
    this.name = 'RequestAborted';
  }
}

export const MAX_TRIES = 5;
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 60_000;

export interface HttpOptions {
  /** Replaced by a fake in tests. */
  fetchFn?: FetchFn;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  requestTimeoutMs?: number;
}

export interface GoogleRequest {
  method: Method;
  /** Address without a query (except the upload session address, which carries its own). */
  url: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Form body for POST (token endpoint). */
  form?: Record<string, string>;
  /** JSON body (a new folder, or the start of an upload). Checked against the allowlist before it is sent. */
  json?: Record<string, unknown>;
  /** The bytes of one upload chunk (PUT). */
  bytes?: Uint8Array<ArrayBuffer>;
  /** Content-Range of the chunk (bytes 0-262143/1000000) or of a status question (bytes, a star, a slash and the total). */
  contentRange?: string;
  /** Total size of the file whose upload is being started (sent as X-Upload-Content-Length). */
  uploadLength?: number;
  /** Statuses besides 2xx that are answers and not errors (308 "resume incomplete"). */
  acceptStatuses?: readonly number[];
  /** True = one try only; the caller decides what to do after a failure (a chunk is never sent again blindly). */
  noRetry?: boolean;
  /** Longer than the usual minute, for a big chunk. */
  timeoutMs?: number;
  /** Value for the Authorization header; kept out of every message. */
  bearer?: string;
  signal?: AbortSignal | undefined;
}

export interface GoogleResponse {
  status: number;
  json: Record<string, unknown>;
  /** The few headers anything needs: the upload session address and how far Google has the file. */
  headers: { location: string | null; range: string | null };
}

const CONTENT_RANGE = /^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RequestAborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** "Retry-After" as milliseconds (seconds or an HTTP date); null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Statuses and reasons that are worth trying again. */
export function isRetryable(status: number, reason: string | null): boolean {
  if (status === 429 || status >= 500) return true;
  return status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded');
}

/** Waiting time after failure number `attempt` (1 = the first): 1 s, 2 s, 4 s, 8 s. A longer Retry-After wins. */
export function backoffDelayMs(attempt: number, retryAfterMs: number | null): number {
  const own = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.min(MAX_DELAY_MS, Math.max(own, retryAfterMs ?? 0));
}

function errorBody(json: Record<string, unknown>): { reason: string | null; text: string } {
  const err = json['error'];
  if (typeof err === 'string') {
    const description = typeof json['error_description'] === 'string' ? `: ${json['error_description']}` : '';
    return { reason: err, text: `${err}${description}` };
  }
  if (err !== null && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const first = Array.isArray(o['errors']) ? (o['errors'][0] as Record<string, unknown> | undefined) : undefined;
    const reason = typeof first?.['reason'] === 'string' ? first['reason'] : typeof o['status'] === 'string' ? o['status'] : null;
    return { reason, text: typeof o['message'] === 'string' ? o['message'] : (reason ?? 'error') };
  }
  return { reason: null, text: 'error' };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class GoogleHttp {
  private readonly fetchFn: FetchFn;
  private readonly sleep: NonNullable<HttpOptions['sleep']>;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: HttpOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Wait before trying again (a caller's own retry loop uses the same sleep as the built-in one). */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return this.sleep(ms, signal);
  }

  /**
   * Send one allowed request. Retries 429, 5xx and Google's rate-limit 403s with 1 s, 2 s, 4 s, 8 s
   * waits (up to 5 tries, honouring Retry-After), unless `noRetry`. Throws RequestNotAllowedError
   * (nothing sent), GoogleApiError, NetworkError or RequestAborted. Secrets are removed from every message.
   */
  async request(req: GoogleRequest): Promise<GoogleResponse> {
    const url = new URL(req.url);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const address = url.toString();
    assertAllowed(req.method, address, req.json); // before anything is sent
    if (req.contentRange !== undefined && !CONTENT_RANGE.test(req.contentRange)) throw new RequestNotAllowedError('the range is not valid');
    if (req.bytes !== undefined && req.method !== 'PUT') throw new RequestNotAllowedError('bytes can only be sent to an upload address');

    for (let attempt = 1; ; attempt += 1) {
      if (req.signal?.aborted) throw new RequestAborted();
      let response: Response;
      try {
        response = await this.send(req, address);
      } catch (err) {
        if (err instanceof RequestAborted) throw err;
        const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
        throw new NetworkError(redact(`${err instanceof Error ? err.message : String(err)}${cause}`));
      }
      // A redirect is never followed. (Google's 308 "resume incomplete" has no Location and is an answer.)
      const redirected = response.status >= 300 && response.status < 400 && !(response.status === 308 && response.headers.get('location') === null);
      if (redirected) throw new GoogleApiError(response.status, 'redirect_refused', `Google answered ${response.status} with a redirect, which Backup Hub does not follow.`);
      const json = await readJson(response);
      if (response.ok || req.acceptStatuses?.includes(response.status)) {
        return { status: response.status, json, headers: { location: response.headers.get('location'), range: response.headers.get('range') } };
      }
      const { reason, text } = errorBody(json);
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
      const failure = new GoogleApiError(response.status, reason, redact(`Google answered ${response.status}: ${text}`), retryAfter);
      if (req.noRetry || !isRetryable(response.status, reason) || attempt >= MAX_TRIES) throw failure;
      await this.sleep(backoffDelayMs(attempt, retryAfter), req.signal);
    }
  }

  /**
   * Starts the download of ONE file's bytes (`GET files/<id>?alt=media`) and hands back the answer with its body still to be read. Retries 429, 5xx and Google's
   * rate-limit 403s like `request`. The time limit is for the answer to start; the caller reads the body and stops it with `signal` when it stalls.
   * Throws RequestNotAllowedError (nothing sent), GoogleApiError, NetworkError or RequestAborted.
   */
  async openDownload(req: { fileId: string; bearer: string; signal?: AbortSignal | undefined }): Promise<Response> {
    const address = `${FILES_URL}/${encodeURIComponent(req.fileId)}?alt=media`;
    assertAllowed('GET', address, undefined, { download: true }); // before anything is sent
    for (let attempt = 1; ; attempt += 1) {
      if (req.signal?.aborted) throw new RequestAborted();
      const startLimit = new AbortController();
      const timer = setTimeout(() => startLimit.abort(), this.timeoutMs);
      let response: Response;
      try {
        // 'error': a redirect is never followed. The limit only covers the start of the answer.
        const init: RequestInit = { method: 'GET', headers: { Authorization: `Bearer ${req.bearer}`, Accept: '*/*' }, redirect: 'error', signal: req.signal ? AbortSignal.any([req.signal, startLimit.signal]) : startLimit.signal };
        response = await this.fetchFn(address, init);
      } catch (err) {
        if (req.signal?.aborted) throw new RequestAborted();
        const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
        throw new NetworkError(redact(`${err instanceof Error ? err.message : String(err)}${cause}`));
      } finally {
        clearTimeout(timer);
      }
      if (response.ok) return response;
      const json = await readJson(response);
      const { reason, text } = errorBody(json);
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
      const failure = new GoogleApiError(response.status, reason, redact(`Google answered ${response.status}: ${text}`), retryAfter);
      if (!isRetryable(response.status, reason) || attempt >= MAX_TRIES) throw failure;
      await this.sleep(backoffDelayMs(attempt, retryAfter), req.signal);
    }
  }

  private async send(req: GoogleRequest, address: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (req.bearer) headers['Authorization'] = `Bearer ${req.bearer}`;
    // 'manual' hands a redirect back as an answer (which `request` then refuses); 'error' fails at once. Neither follows it.
    const init: RequestInit = { method: req.method, headers, redirect: req.method === 'PUT' ? 'manual' : 'error' };
    if (req.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(req.form).toString();
    }
    if (req.json) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      init.body = JSON.stringify(req.json);
      if (req.uploadLength !== undefined) {
        headers['X-Upload-Content-Length'] = String(req.uploadLength);
        headers['X-Upload-Content-Type'] = 'application/octet-stream';
      }
    }
    if (req.method === 'PUT') {
      if (req.contentRange !== undefined) headers['Content-Range'] = req.contentRange;
      if (req.bytes !== undefined) {
        headers['Content-Type'] = 'application/octet-stream';
        init.body = req.bytes;
      }
    }
    const timeout = AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs);
    init.signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    try {
      return await this.fetchFn(address, init);
    } catch (err) {
      if (req.signal?.aborted) throw new RequestAborted();
      throw err;
    }
  }
}
