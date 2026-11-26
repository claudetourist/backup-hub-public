import { upsertFiles } from '../../listing/fileStore';
import { matchMoves } from '../../listing/moveMatch';
import { FolderBackupRun, type FolderCheckpoint } from '../../folderBackup/folderRun';
import { planFolderBackup, type FolderPlanOutcome } from '../../folderBackup/folderPlan';
import type { FolderBackupDeps, FolderSource, SourceLookResult } from '../../folderBackup/folderTypes';
import { sessionFolderName } from '../../phoneBackup/pathMap';
import type { ConfirmedRun } from '../../phoneBackup/runStore';
import type { MirrorDrive } from '../../mirror/mirrorTypes';
import type { CloudCheckState } from '../../listing/cloudOnly';
import type { FolderBackupReport } from '../../../shared/folderBackup';
import { JobAborted } from '../../jobs/jobService';
import { fakeMirrorDrive } from './mirrorWorld.testutil';
import { FakeCtx } from './phoneBackupWorld.testutil';
import { sha256Of } from './fakeDrive.testutil';
import { Crash, type World } from './world.testutil';

/**
 * Folder backups (R2.1) against the fake world of R1.0a: the T7 is an unkind fake drive (unflushed writes lost on unplug, cached versus uncached
 * reads, a link that cannot replace), the backed-up folder is an in-memory folder whose files can be locked or online only. The product code is the
 * real look, plan and run; only the drive and the folder are fakes.
 */
export const BACKUP_ROOT = 'MyData/OneDriveBackup';
export const SOURCE_BASE = 'C:/Fake/OneDrive';

export interface FakeFile {
  content: Buffer;
  mtimeMs: number;
  /** Another program holds the file: opening it fails with EBUSY. */
  locked?: boolean;
  /** OneDrive Files On-Demand: content not on this PC. Reading it is a test failure. */
  cloud?: boolean;
  /** The file system's own id (NTFS file id): kept when the file is renamed, moved or edited in place; a new file gets a new one. */
  fsId?: string;
}

export class FakeFolder implements FolderSource {
  readonly files = new Map<string, FakeFile>();
  /** Every file whose content was read, in order. */
  readonly reads: string[] = [];
  /** Reads of an online-only file. A correct backup leaves this empty. */
  readonly cloudReads: string[] = [];
  readonly cloudAsked: string[] = [];
  /** Windows cannot say for these (the helper failed): they count as online only. */
  readonly unknown = new Set<string>();
  /** The answer `look` gives; null = complete. */
  lookResult: SourceLookResult | null = null;
  /** Mark online-only files in the index too (the listing's own flag). */
  flagCloudInIndex = false;
  readonly words = 'C:\\Fake\\OneDrive';
  readonly relBase = SOURCE_BASE;

  /** The Google Keep notes: no rows are kept in the file list; the look hands the files over in memory. */
  constructor(
    private readonly w: World,
    readonly placeId: string | null,
    readonly cloudAware: boolean,
    private readonly step: () => void,
  ) {}

  private nextId = 1;

  /** A file in the folder: a file already at `rel` is edited in place (it keeps its file system id), any other is a new file with a new id. */
  set(rel: string, content: string, mtimeSec?: number, extra: Partial<FakeFile> = {}): void {
    const fsId = this.files.get(rel)?.fsId ?? `fake-${this.nextId++}`;
    this.files.set(rel, { content: Buffer.from(content), mtimeMs: (mtimeSec ?? this.w.nowSec - 1000) * 1000, fsId, ...extra });
  }

  /** Renamed or moved at the source: the same file (same id, content and date) under another name. */
  rename(from: string, to: string): void {
    const f = this.files.get(from);
    if (!f || this.files.has(to)) throw new Error(`cannot rename ${from} to ${to}`);
    this.files.delete(from);
    this.files.set(to, f);
  }

  /** A folder renamed or moved: every file below it keeps its id. */
  renameFolder(from: string, to: string): number {
    const below = [...this.files.keys()].filter((rel) => rel.startsWith(`${from}/`));
    for (const rel of below) this.rename(rel, `${to}/${rel.slice(from.length + 1)}`);
    return below.length;
  }

  async look(): Promise<SourceLookResult> {
    if (this.lookResult !== null) return this.lookResult;
    if (this.placeId === null) {
      return { complete: true, rootMissing: false, message: null, entries: [...this.files.entries()].map(([rel, f]) => ({ rel, size: f.content.length, mtimeMs: f.mtimeMs, rowId: null, sha256: null, cloudOnly: false })) };
    }
    const rows = [...this.files.entries()].map(([rel, f]) => ({ relPath: `${SOURCE_BASE}/${rel}`, size: f.content.length, mtimeMs: f.mtimeMs, cloudOnly: this.flagCloudInIndex && f.cloud === true, fsId: f.fsId ?? null }));
    const runStart = this.w.nowMs;
    upsertFiles(this.w.db, this.placeId, rows, this.w.nowMs, !this.flagCloudInIndex);
    const live = new Set(rows.map((r) => r.relPath));
    const known = this.w.db.prepare('SELECT id, rel_path FROM files WHERE place_id = ? AND gone_at IS NULL').all(this.placeId) as { id: number; rel_path: string }[];
    for (const r of known) if (!live.has(r.rel_path)) this.w.db.prepare("UPDATE files SET gone_at = ?, gone_reason = 'gone_from_source' WHERE id = ?").run(this.w.nowMs, r.id);
    // The look finished: files renamed or moved are recognised by their id (the listing's own matching).
    await matchMoves(this.w.db, { placeId: this.placeId, runStart, now: this.w.nowMs, pause: async () => undefined });
    return { complete: true, rootMissing: false, message: null };
  }

  async stat(rel: string): Promise<{ size: number; mtimeMs: number } | null> {
    const f = this.files.get(rel);
    return f ? { size: f.content.length, mtimeMs: f.mtimeMs } : null;
  }

  async readFile(rel: string, onBlock: (block: Buffer) => Promise<void> | void): Promise<{ sha256: string; bytes: number }> {
    this.step();
    const f = this.files.get(rel);
    if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (f.cloud) {
      this.cloudReads.push(rel);
      throw Object.assign(new Error('A file that is only in the cloud was opened'), { code: 'EIO' });
    }
    if (f.locked) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    this.reads.push(rel);
    for (let at = 0; at < f.content.length; at += 1024) {
      this.step();
      await onBlock(f.content.subarray(at, at + 1024));
    }
    return { sha256: sha256Of(f.content), bytes: f.content.length };
  }

  async cloudStates(rels: readonly string[]): Promise<Map<string, CloudCheckState>> {
    this.cloudAsked.push(...rels);
    return new Map(rels.map((r) => [r, this.unknown.has(r) ? 'unknown' : this.files.get(r) === undefined ? 'missing' : this.files.get(r)!.cloud ? 'cloud' : 'local']));
  }
}

export interface RunResult {
  report: FolderBackupReport | null;
  crashed: boolean;
  ctx: FakeCtx;
  checkpoint: FolderCheckpoint | null;
}

export class FolderWorld {
  readonly deps: FolderBackupDeps;
  readonly t7: MirrorDrive;
  readonly src: FakeFolder;
  readonly backupId: number;
  readonly laptopPlace: string;
  readonly drivePlace: string;
  readonly root: string;
  readonly flat: boolean;
  /** Every content the folder ever held: a file on the drive with any other content is torn or invented. */
  readonly everContent = new Set<string>();
  wakes = 0;
  private steps = 0;
  private crashAt: number | null = null;
  private unplugAt: number | null = null;
  private lastRun: ConfirmedRun | null = null;
  private jobSeq = 0;

  constructor(
    readonly w: World,
    o: { flat?: boolean; cloudAware?: boolean; root?: string } = {},
  ) {
    this.flat = o.flat === true;
    this.root = o.root ?? BACKUP_ROOT;
    this.drivePlace = w.destinations[0]!.placeId;
    const tag = `f${this.drivePlace}`;
    this.laptopPlace = `laptop-${tag}`;
    w.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, 'laptop', 'Laptop', '{}', 1)").run(this.laptopPlace);
    this.backupId = Number(
      w.db
        .prepare(
          "INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, source_root, folder_prefix, change_rule, import_key, created_at) VALUES (1, ?, 'folder', NULL, 'C:\\Fake\\OneDrive', ?, 'size_or_date', ?, 1)",
        )
        .run(this.flat ? 'Keep notes' : `Folder ${tag}`, this.flat ? 'keep-sync' : 'OneDrive', this.flat ? 'keep-sync' : null).lastInsertRowid,
    );
    w.db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, enabled, position) VALUES (?, ?, ?, ?, 1, 1)').run(this.backupId, this.drivePlace, this.root, 'primary');
    const step = (): void => this.step();
    this.t7 = fakeMirrorDrive(w, 0, 'T7', step);
    this.src = new FakeFolder(w, this.flat ? null : this.laptopPlace, o.cloudAware === true, step);
    this.deps = {
      db: w.db,
      log: { info: () => undefined, warn: () => undefined },
      now: () => w.nowMs,
      driveFor: async (placeId) => (placeId === this.drivePlace && w.drives[0]!.plugged ? { drive: this.t7, label: 'T7' } : null),
      sourceFor: async () => ({ ok: true, source: this.src }),
      wakeCount: () => this.wakes,
      sleep: async () => undefined,
    };
  }

  get sessionFolder(): string {
    return this.flat ? '' : sessionFolderName('OneDrive', new Date(this.w.nowMs));
  }

  /** A file in the folder. */
  put(rel: string, content: string, mtimeSec?: number, extra: Partial<FakeFile> = {}): void {
    this.src.set(rel, content, mtimeSec, extra);
    this.everContent.add(sha256Of(content));
  }

  /** The id of a file's row in the folder's list (after a look). */
  rowOf(rel: string): number {
    return this.w.db.prepare('SELECT id FROM files WHERE place_id = ? AND rel_path = ?').pluck().get(this.laptopPlace, `${SOURCE_BASE}/${rel}`) as number;
  }

  /** A copy an older tool made (or an earlier run of this one): on the drive for good, and in the index. `session` is the dated folder name. */
  seedCopy(rel: string, content: string, o: { session?: string; mtimeSec?: number; origin?: number | null; verified?: string | null; sha?: boolean; below?: string } = {}): number {
    const path = this.flat ? `${this.root}/${rel}` : `${this.root}/${o.session ?? 'OneDrive-05Jul26'}/${o.below ?? rel}`;
    const mtimeSec = o.mtimeSec ?? this.w.nowSec - 1000;
    const drive = this.w.drives[0]!;
    drive.write(path, content, mtimeSec);
    drive.flush(path);
    upsertFiles(this.w.db, this.drivePlace, [{ relPath: path, size: Buffer.byteLength(content), mtimeMs: mtimeSec * 1000, cloudOnly: false }], this.w.nowMs, true);
    const sha = o.sha === false ? null : sha256Of(content);
    this.w.db
      .prepare('UPDATE files SET sha256 = ?, origin_file_id = ?, verified_how = ?, expected_sha256 = ? WHERE place_id = ? AND rel_path = ?')
      .run(sha, o.origin ?? null, o.verified === undefined ? 'imported' : o.verified, sha, this.drivePlace, path);
    this.everContent.add(sha256Of(content));
    return Number(this.w.db.prepare('SELECT id FROM files WHERE place_id = ? AND rel_path = ?').pluck().get(this.drivePlace, path));
  }

  async plan(): Promise<{ outcome: FolderPlanOutcome; ctx: FakeCtx }> {
    const ctx = new FakeCtx();
    return { outcome: await planFolderBackup(this.deps, { backupId: this.backupId }, ctx), ctx };
  }

  /** Plan, confirm everything (minus what `untick` names), run. `crashAfter` kills the run after that many steps (the drive loses what it had not flushed). */
  async backup(options: { crashAfter?: number; unplugAfter?: number; resume?: FolderCheckpoint | null; onAsk?: (m: string) => void; untick?: (path: string) => boolean; plan?: FolderPlanOutcome } = {}): Promise<RunResult & { plan: FolderPlanOutcome }> {
    const outcome = options.plan ?? (await this.plan()).outcome;
    const ctx = new FakeCtx();
    ctx.onAsk = options.onAsk ?? null;
    if (!outcome.result.ok || outcome.stored === null) return { report: null, crashed: false, ctx, checkpoint: null, plan: outcome };
    const s = outcome.stored;
    const items = s.items
      .filter((i) => !options.untick?.(i.path))
      .map((i) => {
        const item: ConfirmedRun['items'][number] = { path: i.path, size: i.size, mtimeSec: i.mtimeSec, destRel: i.destRel, rowId: i.rowId };
        if (i.candidates.length > 0) item.candidates = i.candidates.map((c) => ({ id: c.id, relPath: c.relPath, sha256: c.sha256 }));
        return item;
      });
    const run: ConfirmedRun = { ...s.base, items, relinks: s.relinks, leftOut: { files: 0, bytes: 0 } };
    return { ...(await this.execute(run, ctx, options)), plan: outcome };
  }

  /** Runs the confirmed list again (Continue after a kill): the same list, the checkpoint the first run left. */
  async continueRun(from: RunResult, options: { crashAfter?: number; unplugAfter?: number; onAsk?: (m: string) => void } = {}): Promise<RunResult> {
    const ctx = new FakeCtx();
    ctx.onAsk = options.onAsk ?? null;
    return this.execute(this.lastRun!, ctx, { ...options, resume: from.checkpoint });
  }

  private async execute(run: ConfirmedRun, ctx: FakeCtx, options: { crashAfter?: number; unplugAfter?: number; resume?: FolderCheckpoint | null }): Promise<RunResult> {
    this.lastRun = run;
    this.steps = 0;
    this.crashAt = options.crashAfter ?? null;
    this.unplugAt = options.unplugAfter ?? null;
    let report: FolderBackupReport | null = null;
    let crashed = false;
    try {
      report = await new FolderBackupRun(this.deps, ctx, run, (this.jobSeq += 1), options.resume ?? null).execute();
    } catch (err) {
      if (err instanceof JobAborted) throw err;
      if (!(err instanceof Crash)) throw err;
      crashed = true;
      for (const d of this.w.drives) {
        const was = d.plugged;
        d.unplug();
        if (was) d.plug();
      }
    }
    this.crashAt = null;
    return { report, crashed, ctx, checkpoint: ctx.last as FolderCheckpoint | null };
  }

  private step(): void {
    this.steps += 1;
    if (this.unplugAt !== null && this.steps >= this.unplugAt) {
      this.unplugAt = null;
      this.w.drives[0]!.unplug();
    }
    if (this.crashAt !== null && this.steps >= this.crashAt) throw new Crash();
  }

  // ---- reading the truth back --------------------------------------------------------------------------------------------------

  /** What is on the drive for good under the backup folder: path -> checksum. */
  durable(): Map<string, string> {
    return new Map(this.w.drives[0]!.onDrive().filter((f) => f.path.startsWith(this.root + '/')).map((f) => [f.path, f.sha256]));
  }

  /** The invariants of PLAN 3c for a folder backup. Returns every violation (an empty list = fine). `before` is what was on the drive before the run(s). */
  violations(before: ReadonlyMap<string, string>): string[] {
    const out: string[] = [];
    const drive = this.w.drives[0]!;
    if (drive.overwrites.length > 0) out.push(`overwritten: ${drive.overwrites.join(', ')}`);
    const after = this.durable();
    for (const [p, sha] of before) if (after.get(p) !== sha) out.push(`changed or removed: ${p}`);
    for (const [p, sha] of after) if (!this.everContent.has(sha)) out.push(`torn or invented: ${p}`);
    const rows = this.w.db.prepare("SELECT rel_path, sha256 FROM files WHERE place_id = ? AND verified_how = 'read_both' AND gone_at IS NULL AND backup_run_id IS NOT NULL").all(this.drivePlace) as { rel_path: string; sha256: string }[];
    for (const r of rows) if (after.get(r.rel_path) !== r.sha256) out.push(`index row without its file: ${r.rel_path}`);
    return out;
  }
}
