import type { Db } from '../db';
import type { JobEvent, JobEventLevel, JobListFilter, JobRecord, JobState } from '../../shared/jobs';

/** Raw `jobs` row. */
interface JobRow {
  id: number;
  kind: string;
  title: string;
  state: JobState;
  progress_done: number;
  progress_total: number;
  bytes_done: number;
  bytes_total: number;
  message: string | null;
  warnings_json: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  resume_json: string | null;
  params_json: string;
  paused: number;
  started_by: string | null;
}

interface EventRow {
  id: number;
  job_id: number;
  at: number;
  level: JobEventLevel;
  text: string;
}

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;
/** Job events (log lines) older than this are removed at startup. */
export const EVENT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseWarnings(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    state: row.state,
    progressDone: row.progress_done,
    progressTotal: row.progress_total,
    bytesDone: row.bytes_done,
    bytesTotal: row.bytes_total,
    message: row.message,
    warnings: parseWarnings(row.warnings_json),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    hasCheckpoint: row.resume_json !== null,
    speed: null,
    etaSeconds: null,
    choices: [],
    retriedBy: null,
    paused: row.paused === 1,
    startedBy: row.started_by ?? null,
  };
}

export interface StoredJob {
  record: JobRecord;
  params: unknown;
  resumeJson: string | null;
}

export interface Progress {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  message: string | null;
}

/** Everything the app does to the `jobs` and `job_events` tables. Synchronous (better-sqlite3). */
export class JobStore {
  constructor(private readonly db: Db) {}

  create(kind: string, title: string, params: unknown, now: number, startedBy: string | null = null): number {
    const result = this.db
      .prepare('INSERT INTO jobs (kind, title, state, created_at, params_json, started_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, title, 'queued', now, JSON.stringify(params ?? {}), startedBy);
    return Number(result.lastInsertRowid);
  }

  private row(id: number): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  get(id: number): JobRecord | null {
    const row = this.row(id);
    return row ? rowToRecord(row) : null;
  }

  getStored(id: number): StoredJob | null {
    const row = this.row(id);
    if (!row) return null;
    let params: unknown = {};
    try {
      params = JSON.parse(row.params_json);
    } catch {
      params = {};
    }
    return { record: rowToRecord(row), params, resumeJson: row.resume_json };
  }

  /** Only the parameters (small), without the checkpoint (which can be large). {} when unreadable or the job is gone. */
  paramsOf(id: number): unknown {
    const json = this.db.prepare('SELECT params_json FROM jobs WHERE id = ?').pluck().get(id) as string | undefined;
    if (json === undefined) return {};
    try {
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  list(filter: JobListFilter = {}): JobRecord[] {
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(filter.limit ?? DEFAULT_LIST_LIMIT)));
    const states = filter.states?.filter((s) => typeof s === 'string') ?? [];
    const rows =
      states.length > 0
        ? (this.db
            .prepare(`SELECT * FROM jobs WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`)
            .all(...states, limit) as JobRow[])
        : (this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit) as JobRow[]);
    return rows.map(rowToRecord);
  }

  /** Queued jobs, oldest first. */
  queued(): { id: number; kind: string }[] {
    return this.db.prepare("SELECT id, kind FROM jobs WHERE state = 'queued' AND paused = 0 ORDER BY id").all() as {
      id: number;
      kind: string;
    }[];
  }

  /** Jobs left running, waiting for the user, or still queued (not paused) when the app last closed. None of them starts by itself. */
  interrupted(): StoredJob[] {
    const rows = this.db.prepare("SELECT id FROM jobs WHERE state IN ('running', 'needs_you') OR (state = 'queued' AND paused = 0) ORDER BY id").all() as {
      id: number;
    }[];
    return rows.flatMap((r) => {
      const stored = this.getStored(r.id);
      return stored ? [stored] : [];
    });
  }

  markRunning(id: number, now: number): void {
    this.db
      .prepare("UPDATE jobs SET state = 'running', paused = 0, started_at = COALESCE(started_at, ?), message = NULL WHERE id = ?")
      .run(now, id);
  }

  markNeedsYou(id: number, message: string): void {
    this.db.prepare("UPDATE jobs SET state = 'needs_you', message = ? WHERE id = ?").run(message, id);
  }

  setPaused(id: number, paused: boolean): void {
    this.db.prepare('UPDATE jobs SET paused = ? WHERE id = ?').run(paused ? 1 : 0, id);
  }

  /** A running job the user paused goes back to 'queued' (resume_json is kept) with the flag set. */
  markPaused(id: number, message: string): void {
    this.db.prepare("UPDATE jobs SET state = 'queued', paused = 1, message = ? WHERE id = ?").run(message, id);
  }

  /** An interrupted job goes back to the queue from its checkpoint (kept in resume_json): its end (time, error) is cleared. */
  requeueFromCheckpoint(id: number): void {
    this.db.prepare("UPDATE jobs SET state = 'queued', paused = 0, finished_at = NULL, error = NULL, message = NULL WHERE id = ?").run(id);
  }

  /** Marks an interrupted job as seen (its message). Nothing is deleted; the checkpoint stays. */
  setSeen(id: number, message: string): void {
    this.db.prepare('UPDATE jobs SET message = ? WHERE id = ?').run(message, id);
  }

  /** Ids of jobs that "Pause everything" paused (queued, paused, with that message). They survive a restart this way. */
  pausedWithMessage(message: string): number[] {
    return this.db.prepare("SELECT id FROM jobs WHERE state = 'queued' AND paused = 1 AND message = ? ORDER BY id").pluck().all(message) as number[];
  }

  /** True when some job is running or waiting for its turn (a job the person paused, or one that waits for the person, does not count). */
  anyWorkPending(): boolean {
    return this.db.prepare("SELECT 1 FROM jobs WHERE state = 'running' OR (state = 'queued' AND paused = 0) LIMIT 1").get() !== undefined;
  }

  finish(
    id: number,
    state: 'done' | 'done_warnings' | 'failed',
    now: number,
    fields: { message?: string | null; error?: string | null } = {},
  ): void {
    this.db
      .prepare(
        'UPDATE jobs SET paused = 0, state = ?, finished_at = ?, message = COALESCE(?, message), error = ?, started_at = COALESCE(started_at, ?) WHERE id = ?',
      )
      .run(state, now, fields.message ?? null, fields.error ?? null, now, id);
  }

  saveProgress(id: number, p: Progress): void {
    this.db
      .prepare(
        'UPDATE jobs SET progress_done = ?, progress_total = ?, bytes_done = ?, bytes_total = ?, message = COALESCE(?, message) WHERE id = ?',
      )
      .run(p.done, p.total, p.bytesDone, p.bytesTotal, p.message, id);
  }

  setMessage(id: number, message: string | null): void {
    this.db.prepare('UPDATE jobs SET message = ? WHERE id = ?').run(message, id);
  }

  saveCheckpoint(id: number, resumeJson: string): void {
    this.db.prepare('UPDATE jobs SET resume_json = ? WHERE id = ?').run(resumeJson, id);
  }

  saveWarnings(id: number, warnings: readonly string[]): void {
    this.db.prepare('UPDATE jobs SET warnings_json = ? WHERE id = ?').run(JSON.stringify(warnings), id);
  }

  addEvent(jobId: number, at: number, level: JobEventLevel, text: string): void {
    this.db.prepare('INSERT INTO job_events (job_id, at, level, text) VALUES (?, ?, ?, ?)').run(jobId, at, level, text);
  }

  /** For each job that was retried, the newest job that retried it (read from the "Retried as job #N" lines). */
  retriedByMap(): Map<number, number> {
    const rows = this.db.prepare("SELECT job_id, text FROM job_events WHERE text LIKE 'Retried as job #%' ORDER BY id").all() as { job_id: number; text: string }[];
    const map = new Map<number, number>();
    for (const row of rows) {
      const n = Number(/#(\d+)$/.exec(row.text)?.[1]);
      if (Number.isInteger(n)) map.set(row.job_id, n);
    }
    return map;
  }

  events(jobId: number, limit = 1000): JobEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM (SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(jobId, limit) as EventRow[];
    return rows.map((r) => ({ id: r.id, jobId: r.job_id, at: r.at, level: r.level, text: r.text }));
  }

  /**
   * Delete the app's own job log lines older than 90 days. Returns how many were removed. With `limit` at most that many go (oldest
   * first, in one short transaction): the upkeep process calls it again until it returns 0.
   */
  pruneEvents(now: number, retentionDays: number = EVENT_RETENTION_DAYS, limit?: number): number {
    const cutoff = now - retentionDays * DAY_MS;
    if (limit === undefined) return this.db.prepare('DELETE FROM job_events WHERE at < ?').run(cutoff).changes;
    return this.db.prepare('DELETE FROM job_events WHERE id IN (SELECT id FROM job_events WHERE at < ? ORDER BY id LIMIT ?)').run(cutoff, limit).changes;
  }

  /**
   * Delete finished jobs (done, done with warnings, failed) that ended more than `retentionDays` ago, at most `limit` per call; their log
   * lines go with them. A failed job of the last 90 days is never touched, and neither is a job that is queued, running or waiting for
   * you. These are the app's own history rows.
   */
  pruneOldJobs(now: number, retentionDays: number = EVENT_RETENTION_DAYS, limit = 500): number {
    const cutoff = now - retentionDays * DAY_MS;
    return this.db
      .prepare(
        `DELETE FROM jobs WHERE id IN (
           SELECT id FROM jobs
            WHERE state IN ('done', 'done_warnings', 'failed') AND finished_at IS NOT NULL AND finished_at < ?
              AND NOT (state = 'failed' AND finished_at >= ?)
            ORDER BY id LIMIT ?)`,
      )
      .run(cutoff, cutoff, limit).changes;
  }

  /** When a job of this kind last finished in any way (done, warnings or failed), or null. */
  lastFinishedAt(kind: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(finished_at) AS at FROM jobs WHERE kind = ?')
      .get(kind) as { at: number | null };
    return row.at;
  }

  hasActive(kind: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM jobs WHERE kind = ? AND state IN ('queued', 'running', 'needs_you') LIMIT 1")
        .get(kind) !== undefined
    );
  }
}
