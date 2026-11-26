import { createHash } from 'node:crypto';
import type { Worker } from 'node:worker_threads';
import { createWorker } from '../lifecycle/workers';

/**
 * SHA-256 (and MD5) of bytes handed over block by block, with the hashing done on a worker thread. A copy or a check reads a file in
 * 1-4 MiB blocks; `hash.update` over every block on the main thread stalled the window for up to ~2 s on a big file when the machine was
 * busy (found 25 Nov 2026 with the CPU recorder). The reading and writing stay where they were (the "every block is handed on to the
 * writer" contract of directRead.ts is untouched); only the hashing moves.
 *
 * Every block is COPIED into a fresh buffer that is transferred to the worker, so the caller may reuse its own buffer at once. At most
 * `MAX_IN_FLIGHT` blocks wait at the worker: `update` then waits for an answer, so memory stays bounded and a slow worker slows the copy
 * instead of filling memory. Data up to `INLINE_DIGEST_BYTES` (most files of a folder) is hashed in place: it takes under a millisecond and
 * a round trip to the worker per small file would cost more than it saves.
 *
 * No worker path set (tests, scripts) means every digest is made in place with the same code, so the answers are the same either way.
 * A worker that cannot start at all is given up on for the rest of the run (the digests are then made in place); a worker that stops in the
 * middle of a file fails that file's digest (its blocks are gone) and the next file starts a new worker.
 */

export interface DigestResult {
  sha256: string;
  md5: string | null;
}

export interface BlockDigest {
  /** Hands one block on. The block is copied before this returns. Resolves when the worker is not too far behind. */
  update(block: Uint8Array): Promise<void> | void;
  finish(): Promise<DigestResult>;
  /** Drops the digest without an answer (the read failed). Safe to call after `finish`. */
  abort(): void;
}

export interface DigestOptions {
  md5?: boolean;
  /** Bytes that will be handed on, when known: a small amount is hashed in place. */
  size?: number;
}

/** Data up to this size is hashed in place on the calling thread (SHA-256 does ~0.5 GB/s: well under a millisecond). */
export const INLINE_DIGEST_BYTES = 256 * 1024;
/** Blocks waiting at the worker before `update` waits for an answer. */
export const MAX_IN_FLIGHT = 4;

/** Messages between the main process and `digestWorker.ts`. */
export type DigestRequest =
  | { type: 'open'; id: number; md5: boolean }
  | { type: 'block'; id: number; data: ArrayBuffer }
  | { type: 'finish'; id: number }
  | { type: 'abort'; id: number };
export type DigestReply = { type: 'ready' } | { type: 'ack'; id: number } | { type: 'done'; id: number; sha256: string; md5: string | null } | { type: 'fail'; id: number; message: string };

let workerPath: string | null = null;
let pool: DigestPool | null = null;
let givenUp = false;

/** Sets the built `digestWorker.js` (null: hash in place). Ends a worker started under an earlier path. */
export function setDigestWorkerPath(file: string | null): void {
  closeDigestWorker();
  workerPath = file;
  givenUp = false;
}

/** Ends the worker thread (shutdown, tests). A later digest starts a new one. */
export function closeDigestWorker(): void {
  const p = pool;
  pool = null;
  p?.close();
}

export function startDigest(opts: DigestOptions = {}): BlockDigest {
  const md5 = opts.md5 === true;
  if (workerPath === null || givenUp || (opts.size !== undefined && opts.size <= INLINE_DIGEST_BYTES)) return inlineDigest(md5);
  pool ??= new DigestPool(workerPath);
  return pool.open(md5);
}

function inlineDigest(md5: boolean): BlockDigest {
  const sha = createHash('sha256');
  const m = md5 ? createHash('md5') : null;
  return {
    update(block) {
      sha.update(block);
      m?.update(block);
    },
    finish: () => Promise.resolve({ sha256: sha.digest('hex'), md5: m ? m.digest('hex') : null }),
    abort: () => undefined,
  };
}

interface Session {
  inFlight: number;
  waiters: { resolve: () => void; reject: (err: Error) => void }[];
  result: { resolve: (r: DigestResult) => void; reject: (err: Error) => void } | null;
  failed: Error | null;
  finished: boolean;
}

class DigestPool {
  private worker: Worker | null = null;
  private readonly sessions = new Map<number, Session>();
  private nextId = 1;
  private ready = false;

  constructor(private readonly file: string) {}

  close(): void {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error('The checksum thread was stopped.'));
    void worker?.terminate().catch(() => undefined);
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = createWorker('hashing', this.file);
    worker.unref();
    this.worker = worker;
    this.ready = false;
    worker.on('message', (reply: DigestReply) => this.onReply(reply));
    worker.on('error', (err) => this.onStop(worker, err));
    worker.on('exit', () => this.onStop(worker, new Error('The checksum thread stopped.')));
    return worker;
  }

  private onStop(worker: Worker, err: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    // A worker that never said it was ready cannot start here (missing file): do the hashing in place from now on.
    if (!this.ready) givenUp = true;
    this.failAll(err);
  }

  private failAll(err: Error): void {
    for (const s of this.sessions.values()) this.fail(s, err);
    this.sessions.clear();
  }

  private fail(s: Session, err: Error): void {
    s.failed = err;
    for (const w of s.waiters.splice(0)) w.reject(err);
    s.result?.reject(err);
    s.result = null;
  }

  private onReply(reply: DigestReply): void {
    if (reply.type === 'ready') {
      this.ready = true;
      return;
    }
    const s = this.sessions.get(reply.id);
    if (!s) return;
    switch (reply.type) {
      case 'ack':
        s.inFlight -= 1;
        if (s.inFlight < MAX_IN_FLIGHT) s.waiters.shift()?.resolve();
        return;
      case 'done':
        this.sessions.delete(reply.id);
        s.finished = true;
        s.result?.resolve({ sha256: reply.sha256, md5: reply.md5 });
        s.result = null;
        return;
      case 'fail':
        this.sessions.delete(reply.id);
        this.fail(s, new Error(reply.message));
        return;
    }
  }

  open(md5: boolean): BlockDigest {
    const worker = this.start();
    const id = this.nextId++;
    const s: Session = { inFlight: 0, waiters: [], result: null, failed: null, finished: false };
    this.sessions.set(id, s);
    const send = (m: DigestRequest, transfer?: ArrayBuffer[]): void => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage(m, transfer ?? []);
    };
    send({ type: 'open', id, md5 });
    return {
      update: (block) => {
        if (s.failed) throw s.failed;
        const copy = new Uint8Array(block.byteLength);
        copy.set(block);
        send({ type: 'block', id, data: copy.buffer }, [copy.buffer]);
        s.inFlight += 1;
        if (s.inFlight < MAX_IN_FLIGHT) return undefined;
        return new Promise<void>((resolve, reject) => s.waiters.push({ resolve, reject }));
      },
      finish: () => {
        if (s.failed) return Promise.reject(s.failed);
        return new Promise<DigestResult>((resolve, reject) => {
          s.result = { resolve, reject };
          send({ type: 'finish', id });
        });
      },
      abort: () => {
        if (s.finished || s.failed || !this.sessions.has(id)) return;
        this.sessions.delete(id);
        s.failed = new Error('The checksum was dropped.');
        send({ type: 'abort', id });
      },
    };
  }
}
