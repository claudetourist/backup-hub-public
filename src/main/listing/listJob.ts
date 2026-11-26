import path from 'node:path';
import { LIST_PLACE_JOB_KIND, type ListPlaceParams } from '../../shared/listing';
import type { Db } from '../db';
import { JobFailure, type JobContext, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import { streamCloudOnly } from './cloudOnly';
import { MAX_KEEP_PREFIXES } from './fileStore';
import { inlineQuickWalkRunner, type QuickWalkRunner } from './quickWalkRunner';
import { folderPrefix, toSlashes } from './skipRules';
import { DEFAULT_CHUNK } from './walker';

/** Where a place's folders are on this PC right now, or why they are not reachable. */
export type Located = { ok: true; base: string } | { ok: false; reason: 'unplugged' | 'missing'; message: string };

export interface ListedPlace {
  id: string;
  kind: 'laptop' | 'drive' | 'onedrive';
  label: string;
}

/** What the listing job needs from the rest of the app. Tests pass fakes. */
export interface ListJobEnv {
  /**
   * Find the place's base folder fresh (reads the drive's ID card again, so a drive that was
   * unplugged or swapped is noticed). The laptop's base is '' because its roots are absolute.
   */
  locate(place: ListedPlace): Promise<Located>;
  /** Folders never entered: OneDrive roots (when listing the laptop), the app's data and logs. */
  excludeDirs(place: ListedPlace): string[];
  /** The skip list for this place: folder names never entered. Empty for a backup drive (old archives stay as they are). */
  skipFolders?(place: ListedPlace): string[];
  /** Fills in default roots the first time, then returns them. */
  roots(place: ListedPlace): Promise<string[]>;
  /** The job started for this place (so Sources can show "listing"). */
  started?(jobId: number, placeId: string): void;
  /** The job saved a difference to the file list (new, changed or gone files): the counts made from it are out of date. */
  dataChanged?(): void;
}

export interface ListJobDeps {
  db: Db;
  env: ListJobEnv;
  log: JobServiceLogger;
  now?: (() => number) | undefined;
  chunkSize?: number | undefined;
  /** Runs "Look again" (a worker thread in the app, so the window never waits for it). Defaults to the main thread. */
  quickRunner?: QuickWalkRunner | undefined;
  /** Cloud-only helper; defaults to the PowerShell one. */
  streamCloud?: typeof streamCloudOnly;
}

interface Checkpoint {
  placeId: string;
  runStartedAt: number;
  /** Index of the next root to walk. */
  nextRoot: number;
  filesSeen: number;
  incompleteRoots: number;
  deniedCount: number;
}

/** While a listing saves, the data version moves at most this often. */
const DATA_BUMP_MS = 2000;

/** At most this many access-denied entries are warned about one by one. */
export const MAX_DENIED_WARNINGS = 10;

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function sizeText(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return i === 0 ? `${v} bytes` : `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Thrown inside the run when the drive went away; turned into a "done with warnings" result. */
class Unplugged extends Error {}

export const unpluggedMessage = (label: string): string => `${label} was unplugged; nothing was lost. Plug it in again and choose Check everything to finish.`;

/**
 * Job `list.place` (heavy, one job per place). Walks every root of the place with `opendir` and
 * `lstat` only (no file is opened, no link followed), writes what it finds to `files` in chunks
 * of 2,000, marks files as gone only after a root was walked completely, and sets the place's
 * "last looked" when every root finished. Unreadable entries are warnings; an unplugged drive ends
 * the job as "done with warnings". Resumable per root.
 */
export function listPlaceHandler(deps: ListJobDeps, kind: string = LIST_PLACE_JOB_KIND): JobHandler {
  return {
    kind,
    heavy: true,
    resumable: true,
    run: (ctx) => new ListRun(deps, ctx).run(),
  };
}

class ListRun {
  private readonly now: () => number;
  private denied = 0;
  private incompleteRoots = 0;
  private filesSeen = 0;
  /** Files already counted when this run began (a resumed job), and when it began: for files per second. */
  private seenAtStart = 0;
  private readonly startedMs: number;
  private quick = false;
  private lastBump = 0;
  /** Files the walk of the current root has counted so far (the walk reports a running total per root). */
  private walkSeen = 0;
  private readonly quickTotals = { read: 0, skipped: 0, added: 0, changed: 0, gone: 0, moved: 0 };
  /** Files recognised as renamed or moved by this run's full walks. */
  private movedTotal = 0;

  constructor(
    private readonly deps: ListJobDeps,
    private readonly ctx: JobContext,
  ) {
    this.now = deps.now ?? Date.now;
    this.startedMs = this.now();
  }

  private loadPlace(): ListedPlace {
    const params = this.ctx.params as Partial<ListPlaceParams> | null;
    const placeId = params?.placeId;
    if (typeof placeId !== 'string') throw new JobFailure('This check has no place to check. Press Start on Home to try again.');
    const row = this.deps.db.prepare('SELECT id, kind, label FROM places WHERE id = ?').get(placeId) as
      | { id: string; kind: string; label: string }
      | undefined;
    if (!row) throw new JobFailure('That place no longer exists, so there is nothing to list.');
    if (row.kind !== 'laptop' && row.kind !== 'drive' && row.kind !== 'onedrive') {
      throw new JobFailure('Only the laptop, named drives and OneDrive can be checked.');
    }
    return { id: row.id, kind: row.kind, label: row.label };
  }

  async run(): Promise<string> {
    const { ctx, deps } = this;
    const place = this.loadPlace();
    this.quick = (ctx.params as Partial<ListPlaceParams> | null)?.quick === true && place.kind !== 'onedrive';
    deps.env.started?.(ctx.jobId, place.id);
    const resume = (ctx.resume ?? null) as Checkpoint | null;
    const usable = resume !== null && resume.placeId === place.id;
    const runStart = usable ? resume.runStartedAt : this.now();
    const startIndex = usable ? resume.nextRoot : 0;
    if (usable) {
      this.filesSeen = resume.filesSeen;
      this.incompleteRoots = resume.incompleteRoots;
      this.denied = resume.deniedCount;
      this.seenAtStart = resume.filesSeen;
      ctx.log('info', `Continuing after folder ${startIndex} of the earlier run`);
    }

    const first = await deps.env.locate(place);
    if (!first.ok) return this.stop(place, first);
    const roots = await deps.env.roots(place);
    if (roots.length === 0) {
      throw new JobFailure('There are no folders on the list for this place. Add a folder on Where my files go, then try again.');
    }
    const exclude = deps.env.excludeDirs(place);
    ctx.log('info', `${this.quick ? 'Checking' : 'Checking all of'} ${place.label}: ${plural(roots.length, 'folder')} (only reading names, sizes and dates)`);

    try {
      for (let i = startIndex; i < roots.length; i += 1) {
        const root = roots[i]!;
        const located = i === startIndex ? first : await deps.env.locate(place);
        if (!located.ok) return this.stop(place, located);
        if (this.quick) await this.quickOne(place, located.base, root, exclude);
        else await this.walkOne(place, located.base, root, exclude, runStart);
        ctx.checkpoint({
          placeId: place.id,
          runStartedAt: runStart,
          nextRoot: i + 1,
          filesSeen: this.filesSeen,
          incompleteRoots: this.incompleteRoots,
          deniedCount: this.denied,
        } satisfies Checkpoint);
        await ctx.yield();
      }
    } catch (err) {
      if (err instanceof Unplugged) {
        ctx.warn(err.message);
        deps.log.info(`list.place: ${place.label}: ${err.message}`);
        return err.message;
      }
      throw err;
    }

    if (this.denied > MAX_DENIED_WARNINGS) {
      ctx.warn(`${plural(this.denied - MAX_DENIED_WARNINGS, 'more entry', 'more entries')} could not be read (access denied). The job log has the first ${MAX_DENIED_WARNINGS}.`);
    }
    const stats = await (deps.quickRunner ?? inlineQuickWalkRunner(deps.db)).stats(place.id);
    const cloud = stats.cloudOnly > 0 ? `, ${stats.cloudOnly.toLocaleString('en-US')} only in the cloud` : '';
    if (this.incompleteRoots === 0) {
      deps.db.prepare('UPDATE places SET last_looked_at = ? WHERE id = ?').run(this.now(), place.id);
    } else {
      ctx.warn(
        `${plural(this.incompleteRoots, 'folder')} changed or could not be fully read during the check, so this does not count as a full check. Nothing was marked as missing there. Run it again.`,
      );
    }
    const t = this.quickTotals;
    const summary = this.quick
      ? `Checked ${place.label}: ${plural(t.added, 'new file')}, ${plural(t.changed, 'changed file')}, ${plural(t.gone, 'file')} no longer there${t.moved > 0 ? `, ${plural(t.moved, 'file')} renamed or moved` : ''} (${plural(t.read, 'folder')} read, ${plural(t.skipped, 'folder')} unchanged). Now ${plural(stats.files, 'file')} (${sizeText(stats.totalBytes)}).`
      : `Checked ${plural(stats.files, 'file')} (${sizeText(stats.totalBytes)}${cloud}) on ${place.label}${this.movedTotal > 0 ? `, ${plural(this.movedTotal, 'file')} renamed or moved` : ''}.`;
    ctx.log('info', summary);
    deps.log.info(`list.place: ${summary}`);
    return summary;
  }

  /** "Listing T7: 12,345 files so far · 1,200 files per second" (the total is not known in advance). */
  private progressMessage(place: ListedPlace): string {
    const seconds = (this.now() - this.startedMs) / 1000;
    const rate = seconds >= 2 ? Math.round((this.filesSeen - this.seenAtStart) / seconds) : 0;
    const speed = rate > 0 ? ` · ${rate.toLocaleString('en-US')} files per second` : '';
    return `Checking ${place.label}: ${this.filesSeen.toLocaleString('en-US')} files so far${speed}`;
  }

  /** A drive went away (or OneDrive is not there): end with a warning, not a failure. */
  private stop(place: ListedPlace, located: Extract<Located, { ok: false }>): string {
    this.ctx.warn(located.message);
    this.deps.log.info(`list.place: ${place.label}: ${located.message}`);
    return located.message;
  }

  /** Relative path stored for an absolute path on disk. */
  private relPath(place: ListedPlace, base: string, abs: string): string {
    return place.kind === 'laptop' ? toSlashes(abs) : toSlashes(path.relative(base, abs));
  }

  /** "Look again" at one root: only folders that changed are read (see quickWalker.ts). */
  private async quickOne(place: ListedPlace, base: string, root: string, exclude: readonly string[]): Promise<void> {
    const { ctx, deps } = this;
    const abs = place.kind === 'laptop' ? root : root === '' ? base : path.join(base, ...root.split('/'));
    ctx.log('info', `Checking ${place.kind === 'laptop' ? abs : root === '' ? place.label : root}`);
    let reported = 0;
    const runner = deps.quickRunner ?? inlineQuickWalkRunner(deps.db);
    const result = await runner.run(
      { placeId: place.id, root: abs, rel: place.kind === 'laptop' ? { kind: 'absolute' } : { kind: 'under', base }, excludeDirs: exclude, skipFolders: place.kind === 'drive' ? [] : (deps.env.skipFolders?.(place) ?? []), ...(place.kind === 'drive' ? {} : { trustFsId: true }) },
      {
        now: this.now,
        signal: ctx.signal,
        tick: async (c) => {
          const changes = c.added + c.changed + c.gone;
          if (changes > reported) {
            reported = changes;
            deps.env.dataChanged?.();
          }
          this.filesSeen = c.foldersRead + c.foldersSkipped;
          ctx.progress(this.filesSeen, 0, { message: `Checking ${place.label}: ${this.filesSeen.toLocaleString('en-US')} folders checked` });
          await ctx.yield();
        },
      },
    );
    const t = this.quickTotals;
    t.read += result.foldersRead;
    t.skipped += result.foldersSkipped;
    t.added += result.added;
    t.changed += result.changed;
    t.gone += result.gone;
    t.moved += result.moved;
    if (result.moved > 0) ctx.log('info', `${plural(result.moved, 'file')} renamed or moved (recognised, not counted as new)`);
    if (result.added + result.changed + result.gone > reported) deps.env.dataChanged?.();
    this.denied += result.deniedFolders;
    if (!result.complete) {
      this.incompleteRoots += 1;
      ctx.log('warn', result.rootMissing ? `The folder ${abs} was not found, so it was skipped.` : `The look at ${abs} was not complete (${result.firstError ?? 'unknown problem'})`);
    }
    if (place.kind === 'drive') {
      // The drive may have been unplugged or swapped during the pass: look again before trusting it.
      const again = await deps.env.locate(place);
      if (!again.ok || again.base !== base) throw new Unplugged(again.ok ? unpluggedMessage(place.label) : again.message);
    }
  }

  private async walkOne(place: ListedPlace, base: string, root: string, exclude: readonly string[], runStart: number): Promise<void> {
    const { ctx, deps } = this;
    const abs = place.kind === 'laptop' ? root : root === '' ? base : path.join(base, ...root.split('/'));
    const rootRel = this.relPath(place, base, abs);
    const scopePrefix = place.kind === 'laptop' ? folderPrefix(rootRel) : root === '' ? '' : folderPrefix(root);

    // OneDrive: which of this root's files are only in the cloud (checked before the walk, one lookup).
    let cloudSet: Set<string> | null = null;
    if (place.kind === 'onedrive') {
      cloudSet = new Set();
      const set = cloudSet;
      try {
        await (deps.streamCloud ?? streamCloudOnly)(abs, (p) => set.add(this.relPath(place, base, p)), { signal: ctx.signal });
      } catch (err) {
        if (ctx.signal.aborted) await ctx.yield();
        cloudSet = null;
        ctx.warn(`Could not tell which OneDrive files are only in the cloud (${(err as Error).message}). They are still on the list and never downloaded; the cloud-only flags stay as they were.`);
      }
    }
    const cloud = cloudSet;

    ctx.log('info', `Walking ${place.kind === 'laptop' ? abs : root === '' ? place.label : root}`);
    // The walk and every save run on the listing worker; this thread only shows progress and lets pause and cancel in.
    const runner = deps.quickRunner ?? inlineQuickWalkRunner(deps.db);
    const deniedBefore = this.denied;
    let sampleShown = 0;
    const showDenied = (samples: readonly { kind: string; path: string }[]): void => {
      for (const sample of samples) {
        if (deniedBefore + sampleShown < MAX_DENIED_WARNINGS) {
          ctx.warn(`Could not read ${sample.kind} ${sample.path} (access denied). Files already on the list there were left as they are.`);
        }
        sampleShown += 1;
      }
    };
    const result = await runner.fullWalk(
      {
        placeId: place.id,
        root: abs,
        rel: place.kind === 'laptop' ? { kind: 'absolute' } : { kind: 'under', base },
        excludeDirs: exclude,
        skipFolders: place.kind === 'drive' ? [] : (deps.env.skipFolders?.(place) ?? []),
        oneDriveRoot: place.kind === 'onedrive' ? base : null,
        cloudRels: cloud === null ? null : [...cloud],
        chunkSize: deps.chunkSize ?? DEFAULT_CHUNK,
        ...(place.kind === 'drive' ? {} : { trustFsId: true }),
      },
      {
        now: this.now,
        signal: ctx.signal,
        tick: async (c) => {
          showDenied(c.deniedSamples);
          this.denied = deniedBefore + c.denied;
          // The data version is a small write on this thread while the worker is saving: at most every couple of seconds.
          if (Date.now() - this.lastBump >= DATA_BUMP_MS) {
            this.lastBump = Date.now();
            deps.env.dataChanged?.();
          }
          this.filesSeen += c.filesSeen - this.walkSeen;
          this.walkSeen = c.filesSeen;
          ctx.progress(this.filesSeen, 0, { message: this.progressMessage(place) });
          await ctx.yield();
        },
      },
    );
    showDenied(result.deniedSamples);
    this.denied = deniedBefore + result.denied;
    this.walkSeen = 0;
    if (result.filesSeen > 0) deps.env.dataChanged?.();

    let complete = result.complete;
    if (!complete) {
      if (result.rootMissing && place.kind === 'laptop') {
        ctx.warn(`The folder ${abs} was not found, so it was skipped. Its earlier files were left as they are.`);
      } else if (result.firstError) {
        ctx.log('warn', `The walk of ${abs} was not complete (${result.firstError})`);
      }
    }
    if (place.kind === 'drive') {
      // The drive may have been unplugged or swapped during the walk: look again before trusting "complete".
      const again = await deps.env.locate(place);
      if (!again.ok || again.base !== base) {
        throw new Unplugged(again.ok ? unpluggedMessage(place.label) : again.message);
      }
    }
    if (result.skippedLinks > 0) ctx.log('info', `Skipped ${plural(result.skippedLinks, 'link')} (shortcuts and junctions are never followed)`);

    if (complete) {
      const keepPrefixes = result.deniedFolders.map((f) => folderPrefix(f));
      if (keepPrefixes.length > MAX_KEEP_PREFIXES) {
        complete = false;
        ctx.warn(`Too many folders (${keepPrefixes.length}) could not be read in ${root === '' ? place.label : root}, so nothing there was marked as missing.`);
      } else {
        const { gone, moved } = await runner.finishWalk({
          placeId: place.id,
          scopePrefix,
          keepPrefixes,
          keepPaths: result.deniedFiles,
          runStart,
          folderRoot: place.kind === 'laptop' ? rootRel : root,
          ...(place.kind === 'drive' ? {} : { trustFsId: true }),
        });
        if (moved > 0) {
          this.movedTotal += moved;
          ctx.log('info', `${plural(moved, 'file')} renamed or moved (recognised by the file system's own id: not new, nothing to copy again)`);
          deps.env.dataChanged?.();
        }
        if (gone > 0) {
          ctx.log('info', `${plural(gone, 'file')} on the list earlier ${gone === 1 ? 'is' : 'are'} no longer there (marked, not deleted)`);
          deps.env.dataChanged?.();
        }
      }
    }
    if (!complete) this.incompleteRoots += 1;
  }
}
