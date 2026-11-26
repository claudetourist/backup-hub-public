import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookPhone } from '../../adb/phoneLook';
import { openDatabase, runMigrations, type Db } from '../../db';
import { backedUpAt, judgeChange, type CopyRow, type DestinationRef } from '../compare';
import { runLook, type LookReport } from '../lookRun';
import { loadCopies, loadDestinations, loadPhoneIndex } from '../lookStore';
import { DriveGoneError, ExistsError, FakeDrive, sha256Of, TMP_DIR, type DriveOptions } from './fakeDrive.testutil';
import { FakeAdbShell, FakePhone, type FaultKind } from './fakePhone.testutil';
import { Rng } from './rng.testutil';

/**
 * The fake world of PLAN.md section 8 for look and compare: a fake phone, unkind fake drives, a real (temp) database, and a
 * REFERENCE backup that does the safe-copy steps of section 4 rule 4 against the fake drives. The reference backup is test code, not the
 * product's backup (that is R1.2a): it exists so the invariants of section 3c have something to check, and so later steps can swap it for
 * the real one and keep every check.
 */
export class Crash extends Error {
  constructor() {
    super('The app was killed.');
  }
}

export interface Rig {
  dir: string;
  db: Db;
  close(): void;
}

export function makeRig(): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-look-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  runMigrations(db);
  return {
    dir,
    db,
    close() {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let worldCounter = 0;

export const FOLDERS = ['/sdcard/DCIM', '/sdcard/Documents'] as const;
const DAY_MS = 86_400_000;

export interface CopyLogEntry {
  drive: number;
  path: string;
  sha256: string;
  size: number;
  phoneRel: string;
}

export interface RemovalLogEntry {
  path: string;
  sha256: string;
  proofs: { drive: number; path: string; sha256: string }[];
}

export interface BackupResult {
  report: LookReport;
  copied: number;
  skipped: string[];
  crashed: boolean;
}

export interface WorldOptions {
  seed: number;
  drives?: DriveOptions[];
  /** Crash points: the backup is killed after this many steps of a copy (set per run). */
}

export class World {
  readonly rng: Rng;
  readonly phone: FakePhone;
  readonly shell: FakeAdbShell;
  readonly drives: FakeDrive[] = [];
  readonly destinations: DestinationRef[] = [];
  readonly placeId: string;
  readonly profileId: number;
  readonly copyLog: CopyLogEntry[] = [];
  readonly removals: RemovalLogEntry[] = [];
  /** Every complete content the phone ever held (sha256): a file on a drive with any other content is torn or invented. */
  readonly everContent = new Set<string>();
  nowMs = Date.UTC(2026, 10, 1, 8, 0, 0);
  private seq = 0;
  private steps = 0;
  private crashAt: number | null = null;

  constructor(
    readonly rig: Rig,
    options: WorldOptions,
  ) {
    this.rng = new Rng(options.seed);
    this.phone = new FakePhone(`FAKE-${options.seed}-${(worldCounter += 1)}`);
    this.shell = new FakeAdbShell(this.phone, options.seed + 1);
    const tag = `s${options.seed}-${worldCounter}`;
    this.placeId = `phone-${tag}`;
    const { db } = rig;
    const insertPlace = db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, ?, ?, '{}', 1)");
    insertPlace.run(this.placeId, 'phone', `Fake phone ${tag}`);
    this.profileId = Number(
      db
        .prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, source_root, phone_serial, folder_prefix, change_rule, created_at) VALUES (1, ?, 'phone', ?, '', ?, 'POCO', 'size_and_date', 1)")
        .run(`Backup ${tag}`, this.placeId, this.phone.serial).lastInsertRowid,
    );
    (options.drives ?? [{ caseInsensitive: true }, { caseInsensitive: true, coarseDates: true, unstableIds: true, tornWrites: true }]).forEach((opts, i) => {
      const place = `drive-${tag}-${i + 1}`;
      insertPlace.run(place, 'drive', `Fake drive ${i + 1}`);
      this.drives.push(new FakeDrive(place, opts, new Rng(options.seed * 31 + i)));
      const id = Number(
        db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, enabled, position) VALUES (?, ?, ?, ?, 1, ?)').run(this.profileId, place, 'MyData/POCO', i === 0 ? 'primary' : 'copy', i + 1).lastInsertRowid,
      );
      this.destinations.push({ id, placeId: place, root: 'MyData/POCO', position: i + 1 });
    });
  }

  dispose(): void {
    this.phone.dispose();
  }

  get db(): Db {
    return this.rig.db;
  }

  get nowSec(): number {
    return Math.floor(this.nowMs / 1000);
  }

  get day(): number {
    return Math.floor(this.nowMs / DAY_MS);
  }

  tick(seconds: number): void {
    this.nowMs += seconds * 1000;
  }

  // ---- the phone changes (what happens outside the app) -------------------------------------------------------------------

  private remember(content: Buffer | string): void {
    this.everContent.add(sha256Of(content));
  }

  createFile(remote: string, content: string): void {
    this.phone.write(remote, content, this.nowSec);
    this.remember(content);
  }

  /** An edit changes size and date (the way a real edit does). */
  editFile(remote: string, extra: string): void {
    const content = Buffer.concat([this.phone.read(remote), Buffer.from(extra)]);
    this.phone.write(remote, content, this.nowSec + 1);
    this.remember(content);
  }

  // ---- looking and backing up -----------------------------------------------------------------------------------------------

  look(accept: Parameters<typeof runLook>[0]['accept'] = []): Promise<LookReport> {
    return runLook({ db: this.db, placeId: this.placeId, serial: this.phone.serial, folders: FOLDERS, run: this.shell.run, backupProfileId: this.profileId, accept, now: () => this.nowMs });
  }

  private step(): void {
    this.steps += 1;
    if (this.crashAt !== null && this.steps >= this.crashAt) throw new Crash();
  }

  private phoneRowId(rel: string): number {
    return this.db.prepare('SELECT id FROM files WHERE place_id = ? AND rel_path = ?').pluck().get(this.placeId, rel) as number;
  }

  /**
   * Look, then copy what is not backed up at each plugged-in destination, one file at a time with the safe steps: temp name, flush, read
   * back from the drive itself, compare, a final move that cannot replace, flush, and only then the index row. `crashAfter` kills the run
   * after that many steps (the drives lose what they had not flushed).
   */
  async backup(options: { crashAfter?: number; accept?: Parameters<typeof runLook>[0]['accept'] } = {}): Promise<BackupResult> {
    const report = await this.look(options.accept ?? []);
    const result: BackupResult = { report, copied: 0, skipped: [], crashed: false };
    if (!report.outcome.ok) return result;
    this.steps = 0;
    this.crashAt = options.crashAfter ?? null;
    try {
      for (const e of report.outcome.compare.entries) {
        for (const [i, state] of e.destinations.entries()) {
          if (state.backedUp) continue;
          if (!this.drives[i]!.plugged) {
            result.skipped.push(`${e.path} -> ${this.drives[i]!.name}: not plugged in`);
            continue;
          }
          try {
            if (this.copyOne(i, e.path, e.relPath, e.size, e.mtimeSec)) result.copied += 1;
          } catch (err) {
            if (err instanceof DriveGoneError) result.skipped.push(`${e.path}: drive gone`);
            else throw err;
          }
        }
      }
    } catch (err) {
      if (!(err instanceof Crash)) throw err;
      result.crashed = true;
      for (const d of this.drives) {
        const wasPlugged = d.plugged;
        d.unplug();
        if (wasPlugged) d.plug();
      }
    } finally {
      this.crashAt = null;
    }
    return result;
  }

  private copyOne(driveIndex: number, phonePath: string, rel: string, listedSize: number, listedMtimeSec: number): boolean {
    const drive = this.drives[driveIndex]!;
    let bytes: Buffer;
    try {
      bytes = this.phone.read(phonePath);
    } catch {
      return false; // gone from the phone since the look: the next look finds out
    }
    if (bytes.length !== listedSize) return false; // changed while we looked: the next run copies the new version
    const sha = sha256Of(bytes);
    const tmp = `${TMP_DIR}${(this.seq += 1)}.part`;
    drive.write(tmp, bytes, listedMtimeSec);
    this.step();
    drive.flush(tmp);
    this.step();
    if (sha256Of(drive.readUncached(tmp)) !== sha) {
      drive.discard(tmp);
      return false;
    }
    this.step();
    const root = this.destinations[driveIndex]!.root;
    // A file changed twice in one day keeps both: the second gets a number in its name (the link below can never replace).
    const named = (n: number): string => (n === 1 ? `${root}/POCO-d${this.day}/${rel}` : `${root}/POCO-d${this.day}/${rel}`.replace(/(\.[^./]*)?$/, `-${n}$1`));
    let final = named(1);
    for (let n = 1; ; n += 1) {
      final = named(n);
      try {
        drive.linkNoReplace(tmp, final);
        break;
      } catch (err) {
        if (!(err instanceof ExistsError) || n > 50) throw err;
      }
    }
    this.step();
    drive.discard(tmp);
    drive.flush(final);
    this.step();
    this.db
      .prepare(
        `INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, origin_file_id, expected_sha256, verified_at, verified_how)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'read_both')`,
      )
      .run(this.destinations[driveIndex]!.placeId, final, bytes.length, listedMtimeSec * 1000, sha, this.nowMs, this.nowMs, this.phoneRowId(rel), sha, this.nowMs);
    this.copyLog.push({ drive: driveIndex, path: final, sha256: sha, size: bytes.length, phoneRel: rel });
    return true;
  }

  /**
   * Free up phone space, as R1.5 will: the file leaves the phone only when EVERY destination has a verified copy of its current version
   * AND a fresh read of that copy from the drive equals the phone file's checksum read now. Returns false (nothing removed) otherwise.
   */
  cleanPhoneFile(phonePath: string): boolean {
    const rel = phonePath.replace(/^\//, '');
    const row = loadPhoneIndex(this.db, this.placeId, FOLDERS).find((r) => r.relPath === rel && r.goneAt === null);
    if (!row || !this.phone.exists(phonePath)) return false;
    const st = this.phone.walk().find((f) => f.path === phonePath)!;
    const sha = sha256Of(this.phone.read(phonePath));
    const copies = loadCopies(this.db, [row.id]);
    const proofs: RemovalLogEntry['proofs'] = [];
    for (const [i, dest] of this.destinations.entries()) {
      const drive = this.drives[i]!;
      if (!drive.plugged) return false;
      const state = backedUpAt(row.id, { size: st.size, mtimeMs: st.mtimeSec * 1000, sha256: sha }, dest, copies, 'size_and_date');
      if (!state.backedUp || state.worth !== 'verified') return false;
      const copy = copies.find((c: CopyRow) => c.id === state.copyId)!;
      let fresh: string;
      try {
        fresh = sha256Of(drive.readUncached(copy.relPath));
      } catch {
        return false;
      }
      if (fresh !== sha) return false;
      proofs.push({ drive: i, path: copy.relPath, sha256: fresh });
    }
    this.phone.remove(phonePath);
    this.removals.push({ path: phonePath, sha256: sha, proofs });
    return true;
  }

  // ---- reading the truth back (for the invariants) --------------------------------------------------------------------------

  /** The phone as it is now, in the form of an index row key. */
  phoneNow(): { rel: string; size: number; mtimeSec: number }[] {
    return this.phone.walk().map((f) => ({ rel: f.path.replace(/^\//, ''), size: f.size, mtimeSec: f.mtimeSec }));
  }

  phoneRows(): { id: number; rel_path: string; size: number | null; mtime: number | null; gone_at: number | null; gone_reason: string | null; sha256: string | null }[] {
    return this.db.prepare('SELECT id, rel_path, size, mtime, gone_at, gone_reason, sha256 FROM files WHERE place_id = ? ORDER BY id').all(this.placeId) as never;
  }

  judgeSame(row: { size: number | null; mtime: number | null }, now: { size: number; mtimeSec: number }): boolean {
    return judgeChange('size_and_date', { size: row.size, mtimeMs: row.mtime }, { size: now.size, mtimeMs: now.mtimeSec * 1000 }) === 'same';
  }

  destinationsFromDb(): DestinationRef[] {
    return loadDestinations(this.db, this.profileId);
  }

  async rawLook(): Promise<Awaited<ReturnType<typeof lookPhone>>> {
    return lookPhone(this.shell.run, this.phone.serial, FOLDERS);
  }

  /** A random fault. */
  fault(kind: FaultKind): void {
    this.shell.faults.push(kind);
  }
}
