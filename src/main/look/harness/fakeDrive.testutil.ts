import { createHash } from 'node:crypto';
import { CARD_FOLDER, DRIVE_TMP_FOLDER } from '../../../shared/appFolders';
import { Rng } from './rng.testutil';

/**
 * A backup drive as unkind as the real ones (PLAN.md section 8): a write that was not flushed is lost or torn when the drive is
 * unplugged; reading back without the flush only reads the system's memory (`readCached`), only `readUncached` reads the drive;
 * the final move cannot replace a file (EEXIST); it can ignore case; it can keep dates to 2 seconds; its file ids can change when it is
 * plugged in again. In memory, so thousands of scenarios run fast. Paths use forward slashes; the app's tmp folder on the drive holds temp files.
 */
export class DriveGoneError extends Error {
  constructor(drive: string) {
    super(`The drive ${drive} is not plugged in.`);
  }
}

export class ExistsError extends Error {
  readonly code = 'EEXIST';
  constructor(path: string) {
    super(`EEXIST: ${path} already exists.`);
  }
}

export interface DriveOptions {
  /** NTFS, exFAT: "A.jpg" and "a.jpg" are one name. */
  caseInsensitive?: boolean;
  /** exFAT: modified dates are kept to even seconds. */
  coarseDates?: boolean;
  /** exFAT: file ids are not kept; plugging the drive in again may renumber them. */
  unstableIds?: boolean;
  /** An unflushed write that is caught by an unplug may be left half-written instead of lost. */
  tornWrites?: boolean;
}

interface Stored {
  path: string;
  data: Buffer;
  mtimeSec: number;
  id: number;
  /** A new name for data that was already on the drive: an unplug loses the name, it cannot tear the data. */
  linked?: boolean;
}

export const TMP_DIR = `${CARD_FOLDER}/${DRIVE_TMP_FOLDER}/`;

export const sha256Of = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export class FakeDrive {
  plugged = true;
  /** Writes that replaced a file already at a final name (never at a temp name). A correct backup leaves this empty. */
  readonly overwrites: string[] = [];
  private durable = new Map<string, Stored>();
  private memory = new Map<string, Stored>();
  private nextId = 1;

  constructor(
    readonly name: string,
    readonly options: DriveOptions = {},
    private readonly rng: Rng = new Rng(1),
  ) {}

  private key(p: string): string {
    return this.options.caseInsensitive ? p.toLowerCase() : p;
  }

  private need(): void {
    if (!this.plugged) throw new DriveGoneError(this.name);
  }

  private find(p: string): Stored | undefined {
    return this.memory.get(this.key(p)) ?? this.durable.get(this.key(p));
  }

  /** Writes (into the system's memory only: not on the drive until `flush`). Replaces whatever is at that name, like a plain write does. */
  write(p: string, data: Buffer | string, mtimeSec: number): void {
    this.need();
    if (this.find(p) && !p.startsWith(TMP_DIR)) this.overwrites.push(p);
    const buf = Buffer.from(data);
    this.memory.set(this.key(p), { path: p, data: buf, mtimeSec: this.options.coarseDates ? mtimeSec - (mtimeSec % 2) : mtimeSec, id: this.nextId++ });
  }

  /** Puts the file (or the new name) on the drive for good. */
  flush(p: string): void {
    this.need();
    const k = this.key(p);
    const m = this.memory.get(k);
    if (m) {
      this.durable.set(k, m);
      this.memory.delete(k);
    } else if (!this.durable.has(k)) throw new Error(`flush: ${p} does not exist`);
  }

  exists(p: string): boolean {
    this.need();
    return this.find(p) !== undefined;
  }

  /** What the operating system says: memory first. Proves nothing about the drive. */
  readCached(p: string): Buffer {
    this.need();
    const f = this.find(p);
    if (!f) throw new Error(`ENOENT: ${p}`);
    return f.data;
  }

  /** What is really on the drive (a read that bypasses the cache). A write that was never flushed is not there. */
  readUncached(p: string): Buffer {
    this.need();
    const f = this.durable.get(this.key(p));
    if (!f) throw new Error(`ENOENT (not on the drive): ${p}`);
    return f.data;
  }

  /** What the system lists under a folder prefix (memory first, like a directory listing): path, size, date. The app's own temp folder is not listed. */
  list(prefix: string): { path: string; size: number; mtimeSec: number }[] {
    this.need();
    const seen = new Map<string, Stored>(this.durable);
    for (const [k, v] of this.memory) seen.set(k, v);
    return [...seen.values()].filter((f) => f.path.startsWith(prefix) && !f.path.startsWith(TMP_DIR)).map((f) => ({ path: f.path, size: f.data.length, mtimeSec: f.mtimeSec }));
  }

  /** A new name for the same file; fails with EEXIST if anything is at the new name (never replaces). The new name needs its own flush. */
  linkNoReplace(from: string, to: string): void {
    this.need();
    const src = this.find(from);
    if (!src) throw new Error(`ENOENT: ${from}`);
    if (this.find(to)) throw new ExistsError(to);
    this.memory.set(this.key(to), { ...src, path: to, linked: true });
  }

  /** Removes one of the app's own temp names (the real code does this through danger/ownFiles). */
  discard(p: string): void {
    this.need();
    this.memory.delete(this.key(p));
    this.durable.delete(this.key(p));
  }

  stat(p: string): { size: number; mtimeSec: number; id: number } | null {
    this.need();
    const f = this.find(p);
    return f ? { size: f.data.length, mtimeSec: f.mtimeSec, id: f.id } : null;
  }

  /** What is on the drive for good, whether or not it is plugged in: [path, sha256]. For checks only. */
  onDrive(): { path: string; sha256: string; size: number }[] {
    return [...this.durable.values()].map((f) => ({ path: f.path, sha256: sha256Of(f.data), size: f.data.length }));
  }

  durableSha(p: string): string | null {
    const f = this.durable.get(this.key(p));
    return f ? sha256Of(f.data) : null;
  }

  /** Cable pulled: everything not flushed is lost, or left torn (a random first part). */
  unplug(): void {
    for (const [k, m] of this.memory) {
      if (this.options.tornWrites && !m.linked && m.data.length > 1 && this.rng.chance(0.5)) {
        this.durable.set(k, { ...m, data: m.data.subarray(0, 1 + this.rng.int(m.data.length - 1)) });
      }
    }
    this.memory.clear();
    this.plugged = false;
  }

  plug(): void {
    this.plugged = true;
    if (this.options.unstableIds) for (const f of this.durable.values()) f.id = this.nextId++;
  }
}
