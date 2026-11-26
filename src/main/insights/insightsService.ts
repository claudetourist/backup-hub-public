import type { Db } from '../db';
import type { PlaceView } from '../../shared/places';
import { verdictOf, type DriveHealth, type DriveHealthResult, type HealthFacts, type OnlyHereResult, type OnlyHereSummary, type ReminderDaysResult, type SmartState, type WouldLoseDetail, type WouldLoseFilesRequest, type WouldLoseFilesPage, type WouldLoseFilesResult, type WouldLoseResult } from '../../shared/insights';
import { DISK_EVENT_COMMAND, eventsPerLetter, parseDiskEvents } from './diskEvents';
import { SMART_COMMAND, SMART_UNKNOWN, parseSmart } from './driveSmart';
import { lastChecksByDrive, openProblemsByPlace } from './lastChecks';
import { ReminderStore } from './reminderStore';
import { usbTroublesByDrive } from './usbTroubles';

/** A reading of a disk's health is kept this long (it only changes over weeks); read again when a drive is plugged in and it is older. */
export const SMART_MAX_AGE_MS = 6 * 3_600_000;

export interface InsightsDeps {
  db: Db;
  /** The places as the window shows them (a snapshot kept in memory: no database read). */
  places(): readonly PlaceView[];
  /** Runs a read-only script in a hidden PowerShell child process and returns what it printed. Rejects on failure. */
  runScript(script: string): Promise<string>;
  /** The worker queries. Missing (or null answers) = the screen says it could not be counted. */
  loseInWorker?: ((placeId: string) => Promise<WouldLoseDetail | null>) | undefined;
  loseFilesInWorker?: ((request: WouldLoseFilesRequest) => Promise<WouldLoseFilesPage | null>) | undefined;
  onlyHereInWorker?: (() => Promise<OnlyHereSummary[] | null>) | undefined;
  /** The change counter: the one-line summaries are counted again only when it moved. */
  dataVersion: { current(): number };
  now?: () => number;
  log: { warn(...args: unknown[]): void };
}

/** What Windows said about one drive letter. */
interface DiskReading {
  state: SmartState;
  note: string;
  /** Errors in the System log in the last 30 days; null = the log could not be read. */
  windowsErrors: number | null;
}

interface SmartCache extends DiskReading {
  at: number;
  letter: string;
}

const COULD_NOT_COUNT = 'This could not be counted right now. Nothing was changed.';
const NOT_PLUGGED_IN = 'Not plugged in, so Windows was not asked';

/**
 * Drive health, the reminder days per backup and "What would I lose?". Read only: it never writes to a drive, copies, changes or
 * deletes a file; its one write is the reminder days (a number in the database). Nothing here starts by itself or runs on a timer:
 * the disk health is read only when the window asks AND a drive is plugged in AND the last reading is old.
 */
export class InsightsService {
  private readonly now: () => number;
  private readonly reminders: ReminderStore;
  private readonly smart = new Map<string, SmartCache>();
  private smartReading: Promise<Map<string, DiskReading>> | null = null;
  private summary: { version: number; places: OnlyHereSummary[] } | null = null;
  private summaryCounting: Promise<OnlyHereSummary[] | null> | null = null;

  constructor(private readonly deps: InsightsDeps) {
    this.now = deps.now ?? Date.now;
    this.reminders = new ReminderStore(deps.db);
  }

  // ---- Reminder days ---------------------------------------------------------------------------------------------------------------

  reminderDays(): ReminderDaysResult {
    return { ok: true, days: this.reminders.get() };
  }

  setReminderDays(backupId: number, days: number | null): ReminderDaysResult {
    const exists = this.deps.db.prepare('SELECT 1 FROM backup_profiles WHERE id = ?').get(backupId) !== undefined;
    if (!exists) return { ok: false, message: 'That backup was not found.' };
    const next = this.reminders.set(backupId, days);
    return next === null ? { ok: false, message: 'Please give a number of days from 1 to 365.' } : { ok: true, days: next };
  }

  // ---- Drive health ----------------------------------------------------------------------------------------------------------------

  /** Every place (drives, the laptop, OneDrive, phones, Google accounts) with what the app knows and what Windows says, and one verdict. */
  async driveHealth(): Promise<DriveHealthResult> {
    try {
      const places = this.deps.places();
      // Only a plugged-in drive or the laptop has a disk Windows can be asked about.
      const plugged = places.filter((p) => (p.kind === 'drive' || p.kind === 'laptop') && p.status === 'connected' && /^[A-Za-z]:/.test(p.rootHint ?? ''));
      const readings = plugged.length > 0 ? await this.readDisks(plugged) : new Map<string, DiskReading>();
      const now = this.now();
      const usb = usbTroublesByDrive(this.deps.db, now);
      const checks = lastChecksByDrive(this.deps.db);
      const problems = openProblemsByPlace(this.deps.db);
      const next = this.nextBackupBytes();
      const drives = places.map((p): DriveHealth => {
        const disk = p.kind === 'drive' || p.kind === 'laptop';
        const reading = disk ? (readings.get(p.id) ?? this.smart.get(p.id) ?? null) : null;
        const check = checks.get(p.label) ?? null;
        const open = problems.get(p.id);
        const space = this.spaceOf(p);
        const facts: HealthFacts = {
          kind: p.kind,
          status: p.status,
          lastSeenAt: p.status === 'connected' && p.kind !== 'gdrive' ? now : p.kind === 'gdrive' ? p.lastLookedAt : p.lastConnectedAt,
          freeBytes: space.free,
          capacityBytes: space.capacity,
          smart: disk ? (reading?.state ?? 'unknown') : null,
          windowsErrors: reading?.windowsErrors ?? null,
          usbTroubles: usb.get(p.label) ?? 0,
          readErrors: check?.couldNotRead ?? 0,
          damaged: open?.damaged ?? 0,
          differs: open?.differs ?? 0,
        };
        const { verdict, reasons } = verdictOf(facts, now);
        const smartNote = !disk ? '' : (reading?.note ?? (p.status === 'connected' ? SMART_UNKNOWN.note : NOT_PLUGGED_IN));
        return Object.assign(facts, { placeId: p.id, label: p.label, smartNote, lastCheck: check, nextBackupBytes: next.get(p.id) ?? null, verdict, reasons });
      });
      return { ok: true, drives };
    } catch (err) {
      this.deps.log.warn('insights: drive health failed', err);
      return { ok: false, message: 'The drives could not be checked right now. Nothing was changed.' };
    }
  }

  /** Space as the person thinks of it: a Google account's room is its quota. */
  private spaceOf(p: PlaceView): { free: number | null; capacity: number | null } {
    if (p.kind === 'gdrive') {
      const limit = p.gdrive?.quotaLimitBytes ?? null;
      const used = p.gdrive?.quotaUsageBytes ?? null;
      return limit !== null && used !== null ? { free: Math.max(0, limit - used), capacity: limit } : { free: null, capacity: null };
    }
    return { free: p.freeBytes, capacity: p.capacityBytes };
  }

  /** Reads the disk health once for every plugged-in drive whose last reading is missing or old. One PowerShell at a time. */
  private async readDisks(plugged: readonly PlaceView[]): Promise<Map<string, DiskReading>> {
    const out = new Map<string, DiskReading>();
    const letterOf = (p: PlaceView): string => p.rootHint!.slice(0, 1).toUpperCase() + ':';
    const stale = plugged.filter((p) => {
      const kept = this.smart.get(p.id);
      return !kept || kept.letter !== letterOf(p) || this.now() - kept.at >= SMART_MAX_AGE_MS;
    });
    if (stale.length > 0) {
      this.smartReading ??= this.runDisks().finally(() => {
        this.smartReading = null;
      });
      const byLetter = await this.smartReading;
      for (const p of stale) this.smart.set(p.id, { at: this.now(), letter: letterOf(p), ...(byLetter.get(letterOf(p)) ?? { ...SMART_UNKNOWN, windowsErrors: null }) });
    }
    for (const p of plugged) {
      const kept = this.smart.get(p.id);
      if (kept) out.set(p.id, { state: kept.state, note: kept.note, windowsErrors: kept.windowsErrors });
    }
    return out;
  }

  /** The disk list, then the System log (two reads, one after the other). "Could not tell" is a fine answer: nothing is shown as a problem. */
  private async runDisks(): Promise<Map<string, DiskReading>> {
    let readings: ReturnType<typeof parseSmart> = [];
    try {
      readings = parseSmart(await this.deps.runScript(SMART_COMMAND));
    } catch (err) {
      this.deps.log.warn('insights: the disk health could not be read', err);
    }
    let counts: Map<string, number> | null = null;
    try {
      counts = eventsPerLetter(parseDiskEvents(await this.deps.runScript(DISK_EVENT_COMMAND)), readings);
    } catch (err) {
      this.deps.log.warn('insights: the disk errors in the Windows log could not be read', err);
    }
    return new Map(readings.map((r) => [r.letter, { state: r.state, note: r.note, windowsErrors: counts?.get(r.letter) ?? null }]));
  }

  /** About how big the next backup to each drive is: the biggest of its backups' last successful runs there. A small table. */
  private nextBackupBytes(): Map<string, number> {
    const rows = this.deps.db
      .prepare(
        `SELECT place, max(bytes) FROM (
           SELECT destination_place_id AS place, bytes_copied AS bytes,
                  row_number() OVER (PARTITION BY backup_profile_id, destination_place_id ORDER BY started_at DESC) AS rn
             FROM backup_runs WHERE state IN ('done', 'done_warnings') AND destination_place_id IS NOT NULL
         ) WHERE rn = 1 GROUP BY place`,
      )
      .raw()
      .all() as [string, number][];
    return new Map(rows.filter(([, bytes]) => bytes > 0));
  }

  // ---- What would I lose? ----------------------------------------------------------------------------------------------------------

  async wouldLose(placeId: string): Promise<WouldLoseResult> {
    const place = this.deps.db.prepare('SELECT 1 FROM places WHERE id = ?').get(placeId);
    if (place === undefined) return { ok: false, message: 'That device was not found.' };
    const detail = this.deps.loseInWorker ? await this.deps.loseInWorker(placeId) : null;
    return detail === null ? { ok: false, message: COULD_NOT_COUNT } : { ok: true, detail };
  }

  /** One page of the files (biggest first) that have no checked copy elsewhere, with the words typed in the search box. */
  async wouldLoseFiles(request: WouldLoseFilesRequest): Promise<WouldLoseFilesResult> {
    const place = this.deps.db.prepare('SELECT 1 FROM places WHERE id = ?').get(request.placeId);
    if (place === undefined) return { ok: false, message: 'That device was not found.' };
    const page = this.deps.loseFilesInWorker ? await this.deps.loseFilesInWorker(request) : null;
    return page === null ? { ok: false, message: COULD_NOT_COUNT } : { ok: true, page };
  }

  /** The one-line summary of every device. Counted again only when the data changed since the last count. */
  async onlyHere(): Promise<OnlyHereResult> {
    const version = this.deps.dataVersion.current();
    if (this.summary && this.summary.version === version) return { ok: true, places: this.summary.places };
    if (!this.deps.onlyHereInWorker) return { ok: false, message: COULD_NOT_COUNT };
    this.summaryCounting ??= this.deps.onlyHereInWorker().finally(() => {
      this.summaryCounting = null;
    });
    const places = await this.summaryCounting;
    if (places === null) return { ok: false, message: COULD_NOT_COUNT };
    this.summary = { version, places };
    return { ok: true, places };
  }
}
