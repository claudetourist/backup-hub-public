/**
 * Job `appdata.snapshot` (heavy, per drive): copies the laptop app data list to
 * `<drive's backups made by Backup Hub folder>\Laptop-AppData\<laptop name>\<YYYY-MM-DD>\` (a second run the same day: `-2`). Inside, one folder per source.
 *
 * Every file goes through the shared verified copy (temporary `.bhpart`, read back, hash compare, rename). A file another
 * program holds open (EBUSY, EPERM, EACCES, or one that changes while read) is tried once more at the end and then listed as
 * skipped; the job never fails for skipped files, it ends "done with warnings" ("Close Firefox and run again to include 3
 * files"). The job writes `manifest.json` and `README.txt` last, so a folder without a manifest is an unfinished copy and is
 * never offered for removal. Plain files, no encryption (decided 6 Nov 2026). Nothing is ever overwritten or deleted except
 * this job's own leftover `.bhpart` files of unfinished earlier runs.
 */
import type { Dirent, Stats } from 'node:fs';
import { rawFs as fs } from '../rawFs';
import path from 'node:path';
import { APPDATA_MANIFEST, APPDATA_README, APPDATA_ROOT_FOLDER, APPDATA_SNAPSHOT_JOB_KIND, MIN_DRIVE_FREE_BYTES, type SkippedGroup } from '../../shared/plans';
import { PART_SUFFIX } from '../../shared/localCopy';
import { assertWritable, DriveWriteProtectedError, writeFileAtomicAsync } from '../fsutil';
import { JobAborted, JobFailure, type JobContext, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import { verifiedCopy } from '../localCopy/verifiedCopy';
import { appDataEnvFromProcess, blockedPaths, orderedSources, resolveSource, walkSource, type AppDataEnv, type ResolvedSource, type SourceFile } from './sources';
import type { AppDataSource } from '../../shared/plans';
import { ownRemoveAsync } from '../danger/ownFiles';
import { existsAsync } from '../localCopy/verifiedCopy';
import { backupsFolder } from '../places/appFolders';

export const APPDATA_TITLE = 'Back up laptop app data';

export interface AppDataJobParams {
  placeId: string;
  driveLabel: string;
}

export interface AppDataRunResult {
  files: number;
  bytes: number;
  skipped: SkippedGroup[];
  folder: string;
}

export interface AppDataJobDeps {
  log: JobServiceLogger;
  /** The drive's root folder right now, or null when it is not plugged in. */
  baseOf(placeId: string): Promise<string | null>;
  freeBytes(root: string): number | null | Promise<number | null>;
  sources(): AppDataSource[];
  laptop(): { id: string; name: string };
  env?: () => AppDataEnv;
  now?: () => Date;
  chunkBytes?: number;
  /** Told what the run did, so the plan can show it. */
  record?: (jobId: number, result: AppDataRunResult) => void;
}

const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'ETXTBSY']);
const pad = (n: number): string => String(n).padStart(2, '0');

/** The laptop's name as a safe folder name. */
export function cleanLaptopName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  return cleaned === '' ? 'Laptop' : cleaned.slice(0, 80);
}

export function dateFolderName(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `<backups made by Backup Hub on the drive>\Laptop-AppData\<laptop>` (the layout the user chose on 22 Nov 2026). */
export function laptopFolder(root: string, laptopName: string): string {
  return path.join(backupsFolder(root), APPDATA_ROOT_FOLDER, cleanLaptopName(laptopName));
}

/** First free name today: `2026-11-06`, then `2026-11-06-2`, `-3` ... */
export async function freshDateFolder(parent: string, now: Date): Promise<string> {
  const base = dateFolderName(now);
  let name = base;
  for (let n = 2; await existsAsync(path.join(parent, name)); n += 1) name = `${base}-${n}`;
  return name;
}

interface Pending {
  resolved: ResolvedSource;
  file: SourceFile;
  dest: string;
  reason: string;
}

interface Done {
  source: string;
  folder: string;
  rel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export function appDataSnapshotHandler(deps: AppDataJobDeps): JobHandler {
  return { kind: APPDATA_SNAPSHOT_JOB_KIND, heavy: true, run: (ctx) => new SnapshotRun(deps, ctx).run() };
}

class SnapshotRun {
  private readonly done: Done[] = [];
  private bytesDone = 0;
  private bytesTotal = 0;
  private count = 0;
  private total = 0;
  private readonly skipped = new Map<string, { count: number; files: { source: string; reason: string }[] }>();

  constructor(
    private readonly deps: AppDataJobDeps,
    private readonly ctx: JobContext,
  ) {}

  async run(): Promise<string> {
    const { ctx, deps } = this;
    const params = (ctx.params ?? {}) as Partial<AppDataJobParams>;
    if (typeof params.placeId !== 'string' || params.placeId === '') throw new JobFailure('This backup has no drive in it. Press Start on Home to try again.');
    const label = params.driveLabel ?? 'the drive';
    const root = await deps.baseOf(params.placeId);
    if (root === null || root === '') throw new JobFailure(`${label} is not plugged in. Plug it in and press Retry. Nothing was lost.`);
    const laptop = deps.laptop();
    const parent = laptopFolder(root, laptop.name);
    try {
      assertWritable(path.join(parent, '.guard'));
    } catch (err) {
      if (err instanceof DriveWriteProtectedError) throw new JobFailure(err.message);
      throw err;
    }
    const free = await deps.freeBytes(root);
    if (free !== null && free < MIN_DRIVE_FREE_BYTES) throw new JobFailure(`${label} has less than 2 GB free, so nothing was copied.`);

    const env = (deps.env ?? appDataEnvFromProcess)();
    const blocked = blockedPaths(env);
    const resolved = orderedSources(deps.sources()).flatMap((s) => resolveSource(s, env));
    if (resolved.length === 0) throw new JobFailure('None of the folders on the app data list were found on this laptop, so nothing was copied.');

    // First look: how much there is (the job shows real numbers), and a leftover temporary file of an earlier unfinished run goes.
    const work: { resolved: ResolvedSource; file: SourceFile }[] = [];
    for (const r of resolved) {
      for await (const file of walkSource(r, blocked, () => ctx.yield())) {
        work.push({ resolved: r, file });
        this.bytesTotal += file.size;
      }
    }
    this.total = work.length;
    if (free !== null && free - this.bytesTotal < MIN_DRIVE_FREE_BYTES) throw new JobFailure(`${label} does not have room for this copy (${Math.ceil(this.bytesTotal / 1e6).toLocaleString('en-US')} MB). Nothing was copied.`);
    await this.cleanLeftovers(parent);

    const now = (deps.now ?? (() => new Date()))();
    await fs.promises.mkdir(parent, { recursive: true });
    const folder = await freshDateFolder(parent, now);
    const dated = path.join(parent, folder);
    assertWritable(path.join(dated, '.guard'));
    await fs.promises.mkdir(dated, { recursive: true });
    ctx.log('info', `Copying ${work.length} files to ${label}: ${path.join(APPDATA_ROOT_FOLDER, cleanLaptopName(laptop.name), folder)}`);

    const retry: Pending[] = [];
    for (const [i, item] of work.entries()) {
      await ctx.yield();
      const result = await this.copyOne(item.resolved, item.file, dated, label);
      if (result !== null) retry.push(result);
      ctx.progress(i + 1, this.total, { bytesDone: this.bytesDone, bytesTotal: this.bytesTotal, message: `Copying ${path.basename(item.file.abs)} to ${label} (${i + 1} of ${this.total})` });
    }
    // Locked files: once more at the end, then they are skipped.
    for (const p of retry) {
      await ctx.yield();
      const again = await this.copyOne(p.resolved, p.file, dated, label, true);
      if (again !== null) this.skip(p.resolved, p.file, again.reason);
    }

    const groups: SkippedGroup[] = [...this.skipped].map(([app, v]) => ({ app, count: v.count })).toSorted((a, b) => b.count - a.count || a.app.localeCompare(b.app));
    await this.writeManifest(dated, now, laptop, groups);
    for (const g of groups) ctx.warn(`Close ${g.app} and run again to include ${g.count} ${g.count === 1 ? 'file' : 'files'}`);
    const skippedCount = groups.reduce((n, g) => n + g.count, 0);
    deps.record?.(ctx.jobId, { files: this.done.length, bytes: this.bytesDone, skipped: groups, folder });
    ctx.progress(this.total, this.total, { bytesDone: this.bytesDone, bytesTotal: this.bytesTotal });
    if (this.done.length === 0 && skippedCount > 0) throw new JobFailure('No file could be copied: every file was in use. Close the programs on the list and run it again. Nothing was changed on the drive except an empty dated folder.');
    return `Copied ${this.done.length} files (${Math.round(this.bytesDone / 1e6).toLocaleString('en-US')} MB) to ${label}${skippedCount > 0 ? `; ${skippedCount} in use were left out` : ''}. Nothing was deleted or overwritten.`;
  }

  /** Removes leftover `.bhpart` files in dated folders that never got a manifest (this job's own temporary files only). */
  private async cleanLeftovers(parent: string): Promise<void> {
    let dirs: Dirent[];
    try {
      dirs = await fs.promises.readdir(parent, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || (await existsAsync(path.join(parent, d.name, APPDATA_MANIFEST)))) continue;
      const stack = [path.join(parent, d.name)];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: Dirent[];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(abs);
          else if (e.isFile() && e.name.endsWith(PART_SUFFIX)) {
            assertWritable(abs);
            await ownRemoveAsync(abs);
            this.ctx.log('info', `Removed a leftover temporary file from an earlier run: ${e.name}`);
          }
        }
      }
    }
  }

  private skip(r: ResolvedSource, file: SourceFile, reason: string): void {
    const entry = this.skipped.get(r.app) ?? { count: 0, files: [] };
    entry.count += 1;
    entry.files.push({ source: file.abs, reason });
    this.skipped.set(r.app, entry);
  }

  /** Copies one file. Returns null when it is done (or skipped for good), or what to try once more at the end. */
  private async copyOne(r: ResolvedSource, file: SourceFile, dated: string, label: string, last = false): Promise<Pending | null> {
    const { ctx, deps } = this;
    const destDir = path.join(dated, r.folderName, ...path.dirname(file.rel).split('/').filter((s) => s !== '.'));
    const final = path.join(destDir, path.basename(file.rel));
    const inUse = (reason: string): Pending | null => {
      if (last) {
        this.skip(r, file, reason);
        return null;
      }
      return { resolved: r, file, dest: final, reason };
    };
    // A file that went away since the list was made is simply not there any more.
    let st: Stats;
    try {
      st = await fs.promises.stat(file.abs);
    } catch {
      this.skip(r, file, 'It was not there any more.');
      return null;
    }
    try {
      await (await fs.promises.open(file.abs, 'r')).close();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (LOCKED.has(code)) return inUse(`Another program is using it (${code}).`);
      this.skip(r, file, `It could not be read (${code}).`);
      return null;
    }
    try {
      await fs.promises.mkdir(destDir, { recursive: true });
      const result = await verifiedCopy({
        source: file.abs,
        final,
        size: st.size,
        ...(deps.chunkBytes === undefined ? {} : { chunkBytes: deps.chunkBytes }),
        yieldNow: () => ctx.yield(),
        onProgress: (bytes) => ctx.progress(this.count, this.total, { bytesDone: this.bytesDone + bytes, bytesTotal: this.bytesTotal, message: `Copying ${path.basename(file.abs)} to ${label}` }),
      });
      if (!result.ok) {
        if (result.reason === 'exists') {
          this.skip(r, file, 'A file with that name was already in the dated folder.');
          return null;
        }
        return inUse('It changed while it was being copied.');
      }
      this.count += 1;
      this.bytesDone += st.size;
      this.done.push({ source: file.abs, folder: r.folderName, rel: file.rel, size: st.size, mtimeMs: file.mtimeMs, sha256: result.hashes.sha256 });
      return null;
    } catch (err) {
      if (err instanceof JobAborted) throw err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOSPC') throw new JobFailure(`${label} is full, so the copy stopped. What was copied so far stays in the dated folder (it has no manifest, so it is not counted as a good copy).`);
      if (LOCKED.has(code)) return inUse(`Another program is using it (${code}).`);
      throw err;
    }
  }

  private async writeManifest(dated: string, now: Date, laptop: { id: string; name: string }, groups: SkippedGroup[]): Promise<void> {
    const skippedFiles = [...this.skipped].flatMap(([app, v]) => v.files.map((f) => ({ app, source: f.source, reason: f.reason })));
    const manifest = {
      format: 'backuphub-appdata',
      version: 1,
      device: { id: laptop.id, name: laptop.name },
      date: dateFolderName(now),
      createdAt: now.toISOString(),
      files: this.done.map((d) => ({ folder: d.folder, rel: d.rel, source: d.source, size: d.size, mtime: d.mtimeMs, sha256: d.sha256 })),
      skipped: skippedFiles,
      skippedByApp: groups,
    };
    await writeFileAtomicAsync(path.join(dated, APPDATA_README), README_TEXT);
    await writeFileAtomicAsync(path.join(dated, APPDATA_MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`);
  }
}

const README_TEXT = [
  'What is this?',
  'A copy of the settings and data of some programs on a laptop, made by Backup Hub. Every file was checked after it was copied.',
  '',
  'How to get something back by hand:',
  '1. Close the program first.',
  '2. Open the folder of that program here. The folder names say where each one came from (APPDATA is the Windows "Roaming" folder, LOCALAPPDATA is the "Local" folder).',
  '3. Copy the files back to the same place on the laptop. manifest.json lists every file with its original path.',
  '',
  'Keep this drive safe: the copy contains passwords and sign-ins of those programs. The files are not encrypted.',
  '',
].join('\r\n');
