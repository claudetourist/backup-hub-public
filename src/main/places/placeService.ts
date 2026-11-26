import { randomUUID } from 'node:crypto';
import {
  checkLabel,
  DRIVE_PROBLEM_WORDS,
  type GdrivePlaceInfo,
  type NameDriveRequest,
  type NameDriveResult,
  type PlaceKind,
  type PlaceStatus,
  type PlaceView,
  type PlacesSnapshot,
  type RenameResult,
  type UnnamedDriveView,
} from '../../shared/places';
import type { ListingState, PlaceFileStats } from '../../shared/listing';
import type { PlaceFingerprint } from '../../shared/fingerprint';
import type { DriveRefreshView } from '../../shared/drive';
import type { PlaceJobRef } from '../../shared/jobs';
import type { Db } from '../db';
import { assertWritable, DriveWriteProtectedError, type VolumeFact } from '../fsutil';
import { allFileStats } from '../listing/fileStore';
import type { OneDriveAccount } from '../listing/oneDrive';
import { systemDiskOf, type DiskLetter, type SystemDisk } from './disks';
import { CardExistsError, cardPath, readDriveCard, writeDriveCard, type CardRead, type DriveCard } from './driveCard';
import { isCandidate, matchVolumes, type KnownDrive, type VolumeMatch } from './matching';
import { phoneIsPlugged, phoneSerialOf } from './phonePresence';
import { loadThisDevice, saveThisDeviceLabel, type ThisDevice } from './thisDevice';
import { DRIVE_TYPE_FIXED, DRIVE_TYPE_REMOVABLE, listVolumes as realListVolumes, type Volume } from './volumes';
import { answerDecision, blockedCards, listDecisions, recordDecision, resolveGoneConflicts, resolveGoneDuplicates, type AnswerResult, type DecisionKind, type DriveDecision } from './driveDecisions';

/** How often attached volumes are listed. */
export const POLL_INTERVAL_MS = 10_000;
/** This many failed volume listings in a row and the drives' status becomes "unknown" instead of the last picture. */
export const STALE_AFTER_FAILURES = 2;
/** "Last looked" and free space are rewritten at most this often while nothing else changed. */
export const LOOKED_REFRESH_MS = 60_000;
/** adb is asked which phones are plugged in at most this often (only when a phone place knows its serial). */
export const PHONE_READ_EVERY_MS = 30_000;
/** A phone answer older than this is not trusted: the phone is shown as not connected again. */
export const PHONE_ANSWER_LIFETIME_MS = 90_000;
/** A drive's ID card is given up on after this long (a failing disk can stall a read for a very long time). */
export const CARD_READ_TIMEOUT_MS = 5_000;
/** After a failed card read, that drive letter is not read again for this long (a failing disk is not hammered every poll). */
export const CARD_RETRY_AFTER_MS = 60_000;

export interface PlaceLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const silent: PlaceLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface PlaceServiceDeps {
  db: Db;
  dataDir: string;
  hostname: string;
  appVersion: string;
  /** "C:". Cards are never read from or written to it. */
  systemDrive?: string;
  listVolumes?: () => Promise<Volume[]>;
  /** Which physical disk each drive letter is on. Without it nothing is classified as part of the laptop. */
  listDisks?: () => Promise<DiskLetter[]>;
  /** Finds the OneDrive Personal account (null = absent). Without it no OneDrive place is created. */
  detectOneDrive?: () => Promise<OneDriveAccount | null>;
  readCard?: (root: string) => Promise<CardRead>;
  /** Longest wait for one card read (default `CARD_READ_TIMEOUT_MS`). */
  cardReadTimeoutMs?: number;
  writeCard?: (root: string, card: DriveCard) => void;
  /** Maps "E:" to the folder that is the drive's root. Tests point this at temp folders. */
  rootOf?: (letter: string) => string;
  now?: () => number;
  uuid?: () => string;
  log?: PlaceLogger;
}

interface PlaceRow {
  id: string;
  profile_id: number;
  profile_name: string;
  kind: PlaceKind;
  label: string;
  identity_json: string;
  root_hint: string | null;
  last_looked_at: number | null;
  status: PlaceStatus;
}

/** Without a stats source (tests) file counts are cheap per snapshot only if cached: the snapshot is rebuilt at every poll. */
const CATALOG_COUNT_TTL_MS = 15_000;
/** The registry is read again at most this often to follow a moved OneDrive folder. */
const ONEDRIVE_RECHECK_MS = 5 * 60_000;

interface DriveIdentity {
  serial?: string | null;
  /** Last time the drive was seen plugged in (epoch ms). "Last looked" is a different thing: the last full listing. */
  lastConnectedAt?: number;
  /** Laptop: drive letters on the same physical disk as Windows. */
  laptopVolumes?: string[];
  systemDisk?: { number: number; busType: string | null };
  /** OneDrive places. */
  cid?: string | null;
  email?: string | null;
  userFolder?: string;
  capacity?: number | null;
  free?: number | null;
  cardCreatedAt?: string;
  /** Google Drive places (written by the Fleet Manager v1 import). */
  quotaLimit?: number | null;
  quotaUsage?: number | null;
  quotaUsageDrive?: number | null;
  quotaUsageTrash?: number | null;
  catalog?: { from?: string };
}

function parseIdentity(json: string): DriveIdentity {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A connected drive that carries a card for a place we know. */
export interface ConnectedDrive {
  place: PlaceView;
  /** Root folder of the drive right now (e.g. "E:\\"). */
  root: string;
  card: DriveCard;
}

export class PlaceService {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly appVersion: string;
  private readonly systemDrive: string;
  private readonly listVolumes: () => Promise<Volume[]>;
  private readonly listDisks: (() => Promise<DiskLetter[]>) | null;
  private readonly detectOneDrive: (() => Promise<OneDriveAccount | null>) | null;
  private readonly readCard: (root: string) => Promise<CardRead>;
  private readonly cardReadTimeoutMs: number;
  /** Letters whose card read failed: the failed answer is reused until `until` instead of reading the drive again. */
  private readonly failedCards = new Map<string, { serial: string | null; until: number; read: CardRead }>();
  private readonly writeCard: (root: string, card: DriveCard) => void;
  private readonly rootOf: (letter: string) => string;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly log: PlaceLogger;
  private readonly hostname: string;

  private device: ThisDevice | null = null;
  private volumes: Volume[] = [];
  private matches: VolumeMatch[] = [];
  private listedAt: number | null = null;
  private listError: string | null = null;
  private lastJson = '';
  private catalogCounts: { at: number; counts: Map<string, PlaceFileStats> } | null = null;
  private statsSource: (() => Map<string, PlaceFileStats>) | null = null;
  private statsRecount: (() => void) | null = null;
  private statsCountedAt: (() => number | null) | null = null;
  /** Volume listings that failed one after another; the last good picture is not trusted after a couple of them. */
  private listFailures = 0;
  private systemDisk: SystemDisk | null = null;
  private diskKey = '';
  private oneDriveCheckedAt = 0;
  private listingState: (placeId: string) => ListingState = () => 'idle';
  private rootsOf: (placeId: string) => string[] = () => [];
  private listingDetail: (placeId: string) => string | null = () => null;
  private listingJob: (placeId: string) => PlaceJobRef | null = () => null;
  private fingerprintOf: (placeId: string, kind: string) => PlaceFingerprint | null = () => null;
  private driveRefreshOf: (placeId: string) => DriveRefreshView = () => ({ state: 'idle', detail: null, job: null, signingIn: false });
  private connectedIds = new Set<string>();
  /** Serials adb reported as ready, and when (null: not asked yet). */
  private phonesSeen: { serials: ReadonlySet<string>; at: number } | null = null;
  private phoneSource: (() => Promise<readonly string[] | null>) | null = null;
  /** Serials of phones the person told "Safe to unplug" (adb is let go and not asked until they are plugged in again). */
  private releasedPhones: ReadonlySet<string> = new Set();
  private phoneReading = false;
  /** Cards that must not be written to (an open or rejected drive-identity item), by card id. */
  private blocked = new Map<string, string>();
  private inflight: Promise<PlacesSnapshot> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private suspended = false;
  private readonly changeListeners = new Set<(snapshot: PlacesSnapshot) => void>();
  private readonly connectListeners = new Set<(placeIds: string[]) => void>();

  constructor(deps: PlaceServiceDeps) {
    this.db = deps.db;
    this.dataDir = deps.dataDir;
    this.hostname = deps.hostname;
    this.appVersion = deps.appVersion;
    this.systemDrive = (deps.systemDrive ?? process.env['SystemDrive'] ?? 'C:').toUpperCase();
    this.listVolumes = deps.listVolumes ?? (() => realListVolumes());
    this.listDisks = deps.listDisks ?? null;
    this.detectOneDrive = deps.detectOneDrive ?? null;
    this.readCard = deps.readCard ?? ((root) => readDriveCard(root));
    this.cardReadTimeoutMs = deps.cardReadTimeoutMs ?? CARD_READ_TIMEOUT_MS;
    this.writeCard = deps.writeCard ?? writeDriveCard;
    this.rootOf = deps.rootOf ?? ((letter) => `${letter}\\`);
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? randomUUID;
    this.log = deps.log ?? silent;
    this.reloadBlocked();
  }

  // ---- Setup -------------------------------------------------------------------------------

  /** Load (or create) this-device.json and make sure the laptop has its place row. */
  init(): ThisDevice {
    const device = loadThisDevice(this.dataDir, this.hostname, new Date(this.now()));
    this.device = device;
    const existing = this.getRow(device.id);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO places (id, profile_id, kind, label, identity_json, root_hint, last_looked_at, status, created_at)
           VALUES (?, ?, 'laptop', ?, ?, NULL, NULL, 'connected', ?)`,
        )
        .run(device.id, this.defaultProfileId(), device.label, JSON.stringify({ deviceId: device.id }), this.now());
      this.log.info(`places: created the laptop place "${device.label}" (${device.id})`);
    } else if (existing.label !== device.label) {
      this.db.prepare('UPDATE places SET label = ? WHERE id = ?').run(device.label, device.id);
    }
    return device;
  }

  get thisDevice(): ThisDevice {
    if (!this.device) throw new Error('PlaceService.init() has not run');
    return this.device;
  }

  private defaultProfileId(): number {
    const row = this.db.prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    if (!row) throw new Error('There is no profile to own the place');
    return row.id;
  }

  private getRow(id: string): PlaceRow | undefined {
    return this.db
      .prepare(
        `SELECT p.id, p.profile_id, pr.name AS profile_name, p.kind, p.label, p.identity_json, p.root_hint,
                p.last_looked_at, p.status
         FROM places p JOIN profiles pr ON pr.id = p.profile_id WHERE p.id = ?`,
      )
      .get(id) as PlaceRow | undefined;
  }

  private allRows(): PlaceRow[] {
    return this.db
      .prepare(
        `SELECT p.id, p.profile_id, pr.name AS profile_name, p.kind, p.label, p.identity_json, p.root_hint,
                p.last_looked_at, p.status
         FROM places p JOIN profiles pr ON pr.id = p.profile_id
         WHERE NOT (p.kind = 'gdrive' AND json_valid(p.identity_json) AND json_extract(p.identity_json, '$.removedAt') IS NOT NULL)
         ORDER BY p.created_at, p.label`,
      )
      .all() as PlaceRow[];
  }

  private knownDrives(): KnownDrive[] {
    return this.allRows()
      .filter((row) => row.kind === 'drive')
      .map((row) => ({ placeId: row.id, label: row.label, serial: parseIdentity(row.identity_json).serial ?? null }));
  }

  // ---- Listing -----------------------------------------------------------------------------

  /** Files, size and cloud-only count per place (one pass over the live rows), cached for a few seconds. */
  private fileStats(): Map<string, PlaceFileStats> {
    // The app wires the query worker's cached numbers in; the snapshot never counts rows itself then.
    if (this.statsSource) return this.statsSource();
    const nowMs = this.now();
    if (this.catalogCounts && nowMs - this.catalogCounts.at < CATALOG_COUNT_TTL_MS) return this.catalogCounts.counts;
    const counts = allFileStats(this.db);
    this.catalogCounts = { at: nowMs, counts };
    return counts;
  }

  /** Where file counts come from: a cache filled by the query worker (cheap to call, never queries). */
  setStatsSource(source: () => Map<string, PlaceFileStats>, recount: () => void, countedAt?: () => number | null): void {
    this.statsSource = source;
    this.statsRecount = recount;
    this.statsCountedAt = countedAt ?? null;
  }

  /** Where the Sources screen gets the listing state and the laptop's folders from (set by the app wiring). */
  setListingSources(sources: {
    stateOf: (placeId: string) => ListingState;
    rootsOf: (placeId: string) => string[];
    detailOf?: (placeId: string) => string | null;
    jobOf?: (placeId: string) => PlaceJobRef | null;
  }): void {
    this.listingState = sources.stateOf;
    this.rootsOf = sources.rootsOf;
    if (sources.detailOf) this.listingDetail = sources.detailOf;
    if (sources.jobOf) this.listingJob = sources.jobOf;
  }

  /** Where the Sources screen gets the fingerprint picture of a place from (set by the app wiring). */
  setFingerprintSource(fingerprintOf: (placeId: string, kind: string) => PlaceFingerprint | null): void {
    this.fingerprintOf = fingerprintOf;
  }

  /** Where the Sources screen gets the Google refresh state of an account from (set by the app wiring). */
  setDriveSource(refreshOf: (placeId: string) => DriveRefreshView): void {
    this.driveRefreshOf = refreshOf;
  }

  /** Is the place reachable right now? Used to decide whether "List now" can be offered. */
  /** Where the phones plugged in are read from (adb devices, read only). Asked at most every PHONE_READ_EVERY_MS, and only while a phone place has a serial. */
  setPhoneSource(read: () => Promise<readonly string[] | null>): void {
    this.phoneSource = read;
  }

  /** The serials adb has just reported as ready (the Backups screen asked, or the poll did): phone places with these serials are connected. */
  notePhones(serials: readonly string[]): void {
    this.phonesSeen = { serials: new Set(serials.map((s) => s.trim())), at: this.now() };
    this.publish();
  }

  /** The phones in the "Safe to unplug" state (empty: none). Their cards say so instead of offering the button. */
  noteReleased(serials: readonly string[]): void {
    const next = new Set(serials.map((s) => s.trim()));
    if (next.size === this.releasedPhones.size && [...next].every((s) => this.releasedPhones.has(s))) return;
    this.releasedPhones = next;
    this.publish();
  }

  isConnected(placeId: string): boolean {
    return this.snapshot().places.some((p) => p.id === placeId && p.status === 'connected');
  }

  /** Folders of every OneDrive place, from the database (the laptop is never listed through them). */
  oneDriveFolders(): string[] {
    return this.allRows()
      .filter((r) => r.kind === 'onedrive')
      .map((r) => parseIdentity(r.identity_json).userFolder)
      .filter((f): f is string => typeof f === 'string' && f !== '');
  }

  /**
   * Where a connected place's files are right now, for opening them in Explorer: '' for this laptop (its paths are
   * absolute), the drive's root for a named drive that is plugged in, the user folder for OneDrive. Null when the
   * place is not connected or has no folder.
   */
  baseFolderOf(place: { id: string; kind: string }): string | null {
    if (!this.isConnected(place.id)) return null;
    if (place.kind === 'laptop') return '';
    if (place.kind === 'drive') return this.connectedDrives().find((d) => d.place.id === place.id)?.root ?? null;
    if (place.kind === 'onedrive') {
      const row = this.allRows().find((r) => r.id === place.id);
      const folder = row ? parseIdentity(row.identity_json).userFolder : undefined;
      return typeof folder === 'string' && folder !== '' ? folder : null;
    }
    return null;
  }

  /** The catalog changed (an import finished): recount and tell listeners. */
  catalogChanged(): void {
    this.catalogCounts = null;
    this.statsRecount?.();
    this.publish();
  }

  /** The last known picture, without listing anything. */
  snapshot(): PlacesSnapshot {
    const systemVolume = this.volumes.find((v) => v.letter === this.systemDrive);
    const stats = this.fileStats();
    // After a couple of failed volume listings in a row the last picture is old: a drive is then neither shown as plugged in nor as gone.
    const volumesKnown = this.listFailures < STALE_AFTER_FAILURES;
    const connectedCards = new Map<string, { volume: Volume }>();
    if (volumesKnown) for (const m of this.matches) if (m.kind === 'card') connectedCards.set(m.card.id, { volume: m.volume });
    // Known drives that are plugged in but whose card could not be read: shown as a problem, never as gone and never as usable.
    const troubled = new Map<string, { volume: Volume }>();
    if (volumesKnown) for (const m of this.matches) if (m.kind === 'unreadable') troubled.set(m.placeId, { volume: m.volume });

    const places: PlaceView[] = this.allRows().map((row) => {
      const isLaptop = this.device !== null && row.id === this.device.id;
      const identity = parseIdentity(row.identity_json);
      let status: PlaceStatus = row.status;
      let capacity: number | null = identity.capacity ?? null;
      let free: number | null = identity.free ?? null;
      let rootHint = row.root_hint;
      let problem: string | null = null;
      if (row.kind === 'drive') {
        const live = connectedCards.get(row.id);
        const sick = troubled.get(row.id);
        if (live) {
          status = 'connected';
          capacity = live.volume.capacity;
          free = live.volume.free;
          rootHint = live.volume.letter;
        } else if (sick) {
          status = 'problem';
          capacity = sick.volume.capacity ?? capacity;
          free = sick.volume.free ?? free;
          rootHint = sick.volume.letter ?? rootHint;
          problem = DRIVE_PROBLEM_WORDS(sick.volume.letter);
        } else {
          status = this.listedAt === null || !volumesKnown ? 'unknown' : 'disconnected';
        }
      } else if (row.kind === 'phone') {
        // The phone's own status is only written during a backup; plugged in now is what adb says, matched by serial.
        const seen = this.phonesSeen !== null && this.now() - this.phonesSeen.at <= PHONE_ANSWER_LIFETIME_MS ? this.phonesSeen.serials : null;
        if (phoneIsPlugged(row.identity_json, seen)) status = 'connected';
        else if (seen !== null) status = 'disconnected';
      } else if (isLaptop) {
        status = 'connected';
        capacity = systemVolume?.capacity ?? capacity;
        free = systemVolume?.free ?? free;
        rootHint = systemVolume?.letter ?? rootHint;
      }
      let gdrive: GdrivePlaceInfo | null = null;
      if (row.kind === 'gdrive') {
        const g = identity;
        const refresh = this.driveRefreshOf(row.id);
        gdrive = {
          quotaLimitBytes: typeof g.quotaLimit === 'number' ? g.quotaLimit : null,
          quotaUsageBytes: typeof g.quotaUsage === 'number' ? g.quotaUsage : null,
          quotaDriveBytes: typeof g.quotaUsageDrive === 'number' ? g.quotaUsageDrive : null,
          quotaTrashBytes: typeof g.quotaUsageTrash === 'number' ? g.quotaUsageTrash : null,
          refresh,
          canRefresh: row.status !== 'needs_signin' && refresh.state === 'idle' && !refresh.signingIn,
          fileCount: stats.get(row.id)?.files ?? 0,
          fromV1: g.catalog?.from === 'fleet-manager-v1',
        };
      }
      const listable = row.kind === 'laptop' || row.kind === 'drive' || row.kind === 'onedrive';
      const listing = listable ? this.listingState(row.id) : 'idle';
      const fingerprint = listable ? this.fingerprintOf(row.id, row.kind) : null;
      const view: PlaceView = {
        id: row.id,
        kind: row.kind,
        label: row.label,
        profileId: row.profile_id,
        profileName: row.profile_name,
        status,
        rootHint,
        capacityBytes: capacity,
        freeBytes: free,
        lastLookedAt: row.last_looked_at,
        lastConnectedAt: typeof identity.lastConnectedAt === 'number' ? identity.lastConnectedAt : null,
        files: listable ? (stats.get(row.id) ?? { files: 0, totalBytes: 0, cloudOnly: 0 }) : null,
        listing,
        listingDetail: listing === 'running' ? this.listingDetail(row.id) : null,
        listJob: listable ? this.listingJob(row.id) : null,
        canList: listable && status === 'connected' && listing === 'idle',
        problem,
        fingerprint,
        canFingerprint:
          fingerprint !== null &&
          status === 'connected' &&
          fingerprint.state === 'idle' &&
          fingerprint.fileCount - fingerprint.fingerprintedFiles - fingerprint.failedFiles > 0,
        roots: isLaptop ? this.rootsOf(row.id) : null,
        thisDevice: isLaptop,
        gdrive,
        laptopVolumes: isLaptop ? (identity.laptopVolumes ?? []) : null,
      };
      if (row.kind === 'phone' && this.releasedPhones.has(phoneSerialOf(row.identity_json) ?? '')) view.safeToUnplug = true;
      return view;
    });
    const rank = (p: PlaceView) => (p.thisDevice ? 0 : p.status === 'connected' ? 1 : 2);
    places.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

    const unnamed: UnnamedDriveView[] = [];
    for (const m of this.matches) {
      if (m.kind === 'card' || m.kind === 'unreadable') continue;
      const v = m.volume;
      let reason: string | null = null;
      if (m.kind === 'duplicate') reason = 'Another connected drive already has the same ID card, so this one cannot be named.';
      else if (m.kind === 'invalid-card') reason = `It has an ID card the app cannot read (${m.reason}). It was left alone.`;
      else if (m.kind === 'card-conflict') reason = `It has two different ID cards (${m.card.name} and ${m.oldCard.name}), so it needs your decision. Nothing is written to it.`;
      unnamed.push({
        letter: v.letter ?? '',
        label: v.label,
        fileSystem: v.fileSystem,
        capacityBytes: v.capacity,
        freeBytes: v.free,
        driveType: v.driveType === DRIVE_TYPE_REMOVABLE ? 'removable' : 'fixed',
        canName: reason === null,
        reason,
        probable: m.kind === 'serial' ? { placeId: m.placeId, label: m.label } : null,
      });
    }
    unnamed.sort((a, b) => a.letter.localeCompare(b.letter));
    return { places, unnamed, listedAt: this.listedAt, listError: this.listError, statsCountedAt: this.statsCountedAt?.() ?? null };
  }

  /** What the last volume listing said about a drive root such as "F:\\" (label, removable), or null. Used by the write guard. */
  volumeFact(root: string): VolumeFact | null {
    const letter = root.slice(0, 2).toUpperCase();
    const v = this.volumes.find((x) => x.letter === letter);
    return v ? { label: v.label === '' ? null : v.label, removable: v.driveType === DRIVE_TYPE_REMOVABLE } : null;
  }

  /** List the attached volumes now, update the database and tell listeners if anything changed. */
  refresh(): Promise<PlacesSnapshot> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<PlacesSnapshot> {
    let volumes: Volume[];
    try {
      volumes = await this.listVolumes();
    } catch (err) {
      this.listFailures += 1;
      this.listError = 'Could not list the drives just now. The last known list is shown.';
      this.log.warn('places: volume listing failed:', err);
      return this.publish();
    }
    await this.updateDisks(volumes);
    const laptopLetters = this.laptopLetters();
    const cards = new Map<string, CardRead>();
    const candidates = volumes.filter((v) => isCandidate(v, this.systemDrive, laptopLetters));
    await Promise.all(candidates.map(async (v) => cards.set(v.letter ?? '', await this.readCardOf(v))));
    for (const letter of this.failedCards.keys()) if (!candidates.some((v) => v.letter === letter)) this.failedCards.delete(letter);
    const matches = matchVolumes(volumes, cards, this.knownDrives(), this.systemDrive, this.laptopLetters());
    const now = this.now();
    try {
      this.syncDatabase(matches, volumes, now);
      await this.syncOneDrive(now);
    } catch (err) {
      // Another part of the app (a long folder look) can hold the database for a while. A drive refresh must never take the app down: keep the last
      // known list and try again on the next refresh.
      if ((err as { code?: string }).code?.startsWith('SQLITE_BUSY')) {
        this.log.warn('places: the database was busy; the drive list is refreshed again shortly:', (err as Error).message);
        return this.publish();
      }
      throw err;
    }
    this.volumes = volumes;
    this.matches = matches;
    this.listedAt = now;
    this.listError = null;
    this.listFailures = 0;
    this.readPhones(now);
    return this.publish();
  }

  /** Asks adb which phones are plugged in (not waited for: the drives are published first, the phones follow). */
  private readPhones(now: number): void {
    const read = this.phoneSource;
    if (!read || this.phoneReading) return;
    if (this.phonesSeen !== null && now - this.phonesSeen.at < PHONE_READ_EVERY_MS) return;
    if (!this.allRows().some((row) => row.kind === 'phone' && phoneSerialOf(row.identity_json) !== null)) return;
    this.phoneReading = true;
    void read()
      .then((serials) => this.notePhones(serials ?? []))
      .catch((err) => this.log.warn('places: reading the phones failed:', err))
      .finally(() => {
        this.phoneReading = false;
      });
  }

  /**
   * One card read with a time limit. A read that fails (error, or no answer in time) is `unreadable` and is not repeated for
   * `CARD_RETRY_AFTER_MS`: the failed answer is reused while the same drive (same serial) sits at that letter.
   */
  private async readCardOf(volume: Volume): Promise<CardRead> {
    const letter = volume.letter ?? '';
    const held = this.failedCards.get(letter);
    if (held && held.serial === volume.serial && this.now() < held.until) return held.read;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<CardRead>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'unreadable', reason: 'the drive did not answer in time' }), this.cardReadTimeoutMs);
    });
    const read = (async (): Promise<CardRead> => this.readCard(this.rootOf(letter)))().catch((err: unknown): CardRead => ({ status: 'unreadable', reason: `could not be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})` }));
    let result: CardRead;
    try {
      result = await Promise.race([read, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result.status === 'unreadable') {
      this.failedCards.set(letter, { serial: volume.serial, until: this.now() + CARD_RETRY_AFTER_MS, read: result });
      this.log.warn(`places: the card on ${letter} could not be read (${result.reason}); not trying again for a minute`);
    } else this.failedCards.delete(letter);
    return result;
  }

  /**
   * True when a path is on the physical disk Windows runs from (C:, and on this laptop D: and E:). False for anything on a
   * plugged-in drive, and for a path when the disk layout is not known except the system drive itself.
   */
  isOnLaptopDisk(absPath: string): boolean {
    const letter = absPath.slice(0, 2).toUpperCase();
    if (!/^[A-Z]:$/.test(letter)) return false;
    const known = this.systemDisk?.letters;
    return known ? known.includes(letter) : letter === this.systemDrive.toUpperCase();
  }

  /** Letters of the volumes on the same physical disk as Windows: they belong to the laptop place. */
  private laptopLetters(): ReadonlySet<string> {
    return new Set(this.systemDisk?.letters ?? []);
  }

  /**
   * Learn which physical disk each letter is on. Asked again only when the set of drive letters
   * changes (one PowerShell call). If it fails, the earlier answer stays and nothing is guessed.
   */
  private async updateDisks(volumes: readonly Volume[]): Promise<void> {
    if (!this.listDisks) return;
    const key = volumes
      .map((v) => v.letter)
      .filter((l): l is string => l !== null)
      .toSorted()
      .join(',');
    if (key === this.diskKey) return;
    this.diskKey = key;
    try {
      this.systemDisk = systemDiskOf(await this.listDisks(), this.systemDrive);
    } catch (err) {
      this.log.warn('places: could not read which disk each drive is on:', err);
    }
  }

  /**
   * Create or update the OneDrive Personal place, keyed by the account id (never by path, which can
   * move). Database only; nothing on disk is touched. Absent OneDrive: no place, and an existing one
   * is shown as not connected.
   */
  private async syncOneDrive(now: number): Promise<void> {
    if (!this.detectOneDrive) return;
    if (this.oneDriveCheckedAt !== 0 && now - this.oneDriveCheckedAt < ONEDRIVE_RECHECK_MS) return;
    let account: OneDriveAccount | null;
    try {
      account = await this.detectOneDrive();
    } catch (err) {
      this.log.warn('places: could not look for OneDrive:', err);
      return;
    }
    this.oneDriveCheckedAt = now;
    const rows = this.allRows().filter((r) => r.kind === 'onedrive');
    if (!account) {
      for (const row of rows) {
        if (row.status !== 'disconnected') this.db.prepare(`UPDATE places SET status = 'disconnected' WHERE id = ?`).run(row.id);
      }
      return;
    }
    const cidOf = (r: PlaceRow) => parseIdentity(r.identity_json).cid ?? null;
    let row = account.cid !== null ? rows.find((r) => cidOf(r) === account.cid) : undefined;
    // Same account found without its id (or the other way round): adopt the single place rather than add a second one.
    if (!row && rows.length === 1 && (account.cid === null || cidOf(rows[0]!) === null)) row = rows[0];
    if (!row) {
      const identity: DriveIdentity = { cid: account.cid, email: account.email, userFolder: account.userFolder, lastConnectedAt: now };
      this.db
        .prepare(
          `INSERT INTO places (id, profile_id, kind, label, identity_json, root_hint, last_looked_at, status, created_at)
           VALUES (?, ?, 'onedrive', 'OneDrive', ?, ?, NULL, 'connected', ?)`,
        )
        .run(this.uuid(), this.defaultProfileId(), JSON.stringify(identity), account.userFolder, now);
      this.log.info('places: found OneDrive, created its place');
      return;
    }
    const old = parseIdentity(row.identity_json);
    const identity: DriveIdentity = {
      ...old,
      cid: account.cid ?? old.cid ?? null,
      email: account.email ?? old.email ?? null,
      userFolder: account.userFolder,
      lastConnectedAt: now,
    };
    this.db
      .prepare(`UPDATE places SET status = 'connected', root_hint = ?, identity_json = ? WHERE id = ?`)
      .run(account.userFolder, JSON.stringify(identity), row.id);
  }

  private syncDatabase(matches: readonly VolumeMatch[], volumes: readonly Volume[], now: number): void {
    const write = this.db.transaction(() => {
      const seen = new Set<string>();
      for (const m of matches) {
        if (m.kind !== 'card') continue;
        seen.add(m.card.id);
        const identity: DriveIdentity = {
          serial: m.volume.serial,
          capacity: m.volume.capacity,
          free: m.volume.free,
          cardCreatedAt: m.card.createdAt,
          lastConnectedAt: now,
        };
        const row = this.getRow(m.card.id);
        if (row && row.kind === 'drive') {
          // The card matches. It is the same drive only if its serial and size still match what is stored: otherwise ask, write
          // nothing to it, and never overwrite the stored facts silently.
          const stored = parseIdentity(row.identity_json);
          const serialDiffers = typeof stored.serial === 'string' && typeof m.volume.serial === 'string' && stored.serial !== m.volume.serial;
          const sizeDiffers = typeof stored.capacity === 'number' && typeof m.volume.capacity === 'number' && stored.capacity !== m.volume.capacity;
          if (serialDiffers) this.noteDecision(m.card.id, 'serial_changed', { name: m.card.name, letter: m.volume.letter, storedSerial: stored.serial, foundSerial: m.volume.serial, foundCapacity: m.volume.capacity }, now);
          if (sizeDiffers) this.noteDecision(m.card.id, 'size_changed', { name: m.card.name, letter: m.volume.letter, storedCapacity: stored.capacity, foundCapacity: m.volume.capacity, foundSerial: m.volume.serial }, now);
          if (serialDiffers) delete identity.serial;
          if (sizeDiffers) delete identity.capacity;
        }
        if (!row) {
          this.db
            .prepare(
              `INSERT INTO places (id, profile_id, kind, label, identity_json, root_hint, last_looked_at, status, created_at)
               VALUES (?, ?, 'drive', ?, ?, ?, NULL, 'connected', ?)`,
            )
            .run(m.card.id, this.defaultProfileId(), m.card.name, JSON.stringify(identity), m.volume.letter, now);
          this.log.info(`places: new drive "${m.card.name}" (${m.card.id}) at ${m.volume.letter ?? '?'}`);
          continue;
        }
        if (row.kind !== 'drive') continue;
        const changed = row.status !== 'connected' || row.root_hint !== m.volume.letter;
        // "Last looked" is the last full file listing and is not touched here; only the connect time moves.
        const old = parseIdentity(row.identity_json);
        const stale = old.lastConnectedAt === undefined || now - old.lastConnectedAt >= LOOKED_REFRESH_MS;
        if (changed || stale) {
          this.db
            .prepare(`UPDATE places SET status = 'connected', root_hint = ?, identity_json = ? WHERE id = ?`)
            .run(m.volume.letter, JSON.stringify({ ...old, ...identity }), row.id);
        }
      }
      // Two connected drives with one card: nothing is written to either until the person decides.
      const duplicated = new Set<string>();
      for (const m of matches) {
        if (m.kind !== 'duplicate') continue;
        duplicated.add(m.card.id);
        const letters = matches.filter((x) => (x.kind === 'card' || x.kind === 'duplicate') && x.card.id === m.card.id).map((x) => x.volume.letter ?? '?').toSorted();
        this.noteDecision(m.card.id, 'cloned_card', { name: m.card.name, letters }, now);
      }
      resolveGoneDuplicates(this.db, duplicated, now);
      // A card at the new place and another at the old place that name different drives: nothing is written to it until only one is left.
      const conflicted = new Set<string>();
      for (const m of matches) {
        if (m.kind !== 'card-conflict') continue;
        conflicted.add(m.card.id);
        this.noteDecision(m.card.id, 'card_conflict', { name: m.card.name, oldName: m.oldCard.name, oldId: m.oldCard.id }, now);
      }
      resolveGoneConflicts(this.db, conflicted, now);
      this.reloadBlocked();
      // A known drive that is plugged in but did not read is not "gone": its status is left as it was.
      const pluggedIn = new Set<string>();
      for (const m of matches) if (m.kind === 'unreadable') pluggedIn.add(m.placeId);
      for (const row of this.allRows()) {
        if (row.kind === 'drive' && !seen.has(row.id) && !pluggedIn.has(row.id) && row.status !== 'disconnected') {
          this.db.prepare(`UPDATE places SET status = 'disconnected' WHERE id = ?`).run(row.id);
        }
      }
      if (this.device) {
        const laptop = this.getRow(this.device.id);
        if (laptop) {
          const sys = volumes.find((v) => v.letter === this.systemDrive);
          const old = parseIdentity(laptop.identity_json);
          const next: DriveIdentity = { ...old };
          if (this.systemDisk) {
            next.laptopVolumes = this.systemDisk.letters;
            next.systemDisk = { number: this.systemDisk.diskNumber, busType: this.systemDisk.busType };
          }
          const nextJson = JSON.stringify(next);
          const rootHint = sys?.letter ?? laptop.root_hint;
          if (laptop.status !== 'connected' || laptop.root_hint !== rootHint || nextJson !== laptop.identity_json) {
            this.db
              .prepare(`UPDATE places SET status = 'connected', root_hint = ?, identity_json = ? WHERE id = ?`)
              .run(rootHint, nextJson, laptop.id);
          }
        }
      }
    });
    write();
  }

  private noteDecision(placeId: string, kind: DecisionKind, detail: Record<string, unknown>, now: number): void {
    if (recordDecision(this.db, placeId, kind, detail, now)) this.log.warn(`places: needs your decision (${kind}) for the drive "${String(detail['name'])}"; nothing is written to it until you answer`);
  }

  private reloadBlocked(): void {
    this.blocked = blockedCards(this.db);
  }

  /** The plain sentence why nothing may be written to the drive with this card id, or null. Read by the write guard. */
  identityBlock(cardId: string): string | null {
    return this.blocked.get(cardId.toLowerCase()) ?? null;
  }

  /** The "Needs your decision" items about drive identity (open ones, and rejected ones that keep a drive blocked). */
  driveDecisions(onlyOpen = false): DriveDecision[] {
    return listDecisions(this.db, onlyOpen);
  }

  /** The person's answer. 'accepted' = the same drive: the new serial and size are stored now. */
  answerDriveDecision(id: number, answer: 'accepted' | 'rejected'): AnswerResult {
    const result = answerDecision(this.db, id, answer, this.now());
    if (result.ok && answer === 'accepted') {
      const row = this.getRow(result.decision.placeId);
      if (row) {
        const old = parseIdentity(row.identity_json);
        const d = result.decision.detail;
        const next: DriveIdentity = { ...old };
        if (result.decision.kind === 'serial_changed' && typeof d['foundSerial'] === 'string') next.serial = d['foundSerial'];
        if (result.decision.kind === 'size_changed' && typeof d['foundCapacity'] === 'number') next.capacity = d['foundCapacity'];
        this.db.prepare('UPDATE places SET identity_json = ? WHERE id = ?').run(JSON.stringify(next), row.id);
      }
    }
    this.reloadBlocked();
    return result;
  }

  /** Build the snapshot, notify listeners when it differs from the last one. */
  private publish(): PlacesSnapshot {
    const snap = this.snapshot();
    const connected = new Set(snap.places.filter((p) => p.kind === 'drive' && p.status === 'connected').map((p) => p.id));
    const newly = [...connected].filter((id) => !this.connectedIds.has(id));
    this.connectedIds = connected;
    const json = JSON.stringify(snap);
    if (json !== this.lastJson) {
      this.lastJson = json;
      for (const listener of this.changeListeners) listener(snap);
    }
    if (newly.length > 0) for (const listener of this.connectListeners) listener(newly);
    return snap;
  }

  /** Tell listeners again (a profile was renamed, so owner names in the snapshot changed). */
  republish(): void {
    this.publish();
  }

  onChanged(listener: (snapshot: PlacesSnapshot) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Called with the ids of named drives that just appeared (including at the first listing). */
  onDriveConnected(listener: (placeIds: string[]) => void): () => void {
    this.connectListeners.add(listener);
    return () => {
      this.connectListeners.delete(listener);
    };
  }

  /** Named drives that are connected right now, with their root folder and card. */
  connectedDrives(): ConnectedDrive[] {
    const snap = this.snapshot();
    const out: ConnectedDrive[] = [];
    for (const m of this.matches) {
      if (m.kind !== 'card' || !m.volume.letter) continue;
      const place = snap.places.find((p) => p.id === m.card.id);
      if (place) out.push({ place, root: this.rootOf(m.volume.letter), card: m.card });
    }
    return out;
  }

  // ---- Polling -----------------------------------------------------------------------------

  /** List every `POLL_INTERVAL_MS` (skipped while suspended). The first listing happens now. */
  startPolling(intervalMs: number = POLL_INTERVAL_MS): void {
    if (this.timer) return;
    void this.refresh().catch((err: unknown) => this.log.warn('places: refresh failed:', err));
    this.timer = setInterval(() => {
      if (!this.suspended) void this.refresh().catch((err: unknown) => this.log.warn('places: refresh failed:', err));
    }, intervalMs);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Laptop going to sleep: no listing until resume(). */
  suspend(): void {
    this.suspended = true;
  }

  /** Laptop woke up: a drive may have been removed meanwhile, so look right away. */
  resume(): void {
    this.suspended = false;
    if (this.timer) void this.refresh().catch((err: unknown) => this.log.warn('places: refresh failed:', err));
  }

  // ---- Actions the user asks for -----------------------------------------------------------

  /**
   * "Name this drive": the ONE action that writes to a drive. Needs `confirmed: true` (the UI
   * shows the sentence and asks), a freshly listed non-system removable or fixed drive that has
   * no card, and a name no other drive uses. Never overwrites a card.
   */
  async nameDrive(request: NameDriveRequest): Promise<NameDriveResult> {
    const confirmed: unknown = request.confirmed;
    if (confirmed !== true) {
      return { ok: false, code: 'needs-confirmation', message: 'Please confirm first. Nothing was written.' };
    }
    const letterMatch = /^([A-Za-z]):?$/.exec(typeof request.letter === 'string' ? request.letter.trim() : '');
    if (!letterMatch) return { ok: false, code: 'not-found', message: 'That drive letter is not valid. Nothing was written.' };
    const letter = `${letterMatch[1]!.toUpperCase()}:`;
    if (letter === this.systemDrive) {
      return { ok: false, code: 'system-drive', message: `${letter} is the drive Windows runs from. Backup Hub will not put a file there.` };
    }
    if (this.laptopLetters().has(letter)) {
      return {
        ok: false,
        code: 'system-drive',
        message: `${letter} is part of the disk inside this laptop (the same one Windows runs from), so it belongs to the laptop and cannot be named as a backup drive. Nothing was written.`,
      };
    }
    const name = checkLabel(request.name, 'drive name');
    if (!name.ok) return { ok: false, code: 'bad-name', message: name.message };

    // Look again right now: the drive in this letter may not be the one the user saw.
    const snap = await this.refresh();
    const candidate = this.matches.find((m) => m.volume.letter === letter);
    if (!candidate) {
      return { ok: false, code: 'not-found', message: `${letter} is not connected any more. Nothing was written.` };
    }
    if (candidate.volume.driveType !== DRIVE_TYPE_REMOVABLE && candidate.volume.driveType !== DRIVE_TYPE_FIXED) {
      return { ok: false, code: 'not-allowed', message: 'Only removable or fixed disks can be named. Nothing was written.' };
    }
    if (candidate.kind === 'card') {
      return { ok: false, code: 'has-card', message: `${letter} already has an ID card (${candidate.card.name}). Nothing was written.` };
    }
    if (candidate.kind === 'unreadable') {
      return { ok: false, code: 'has-card', message: `${DRIVE_PROBLEM_WORDS(letter)} It was left alone.` };
    }
    if (candidate.kind === 'duplicate' || candidate.kind === 'invalid-card' || candidate.kind === 'card-conflict') {
      return { ok: false, code: 'has-card', message: 'This drive has a card that cannot be used. It was left alone.' };
    }

    let id: string;
    if (request.existingPlaceId !== undefined) {
      if (candidate.kind !== 'serial' || candidate.placeId !== request.existingPlaceId) {
        return { ok: false, code: 'not-found', message: 'This drive no longer matches the one you confirmed. Nothing was written.' };
      }
      id = request.existingPlaceId;
    } else {
      id = this.uuid();
    }
    const clash = snap.places.find((p) => p.kind === 'drive' && p.id !== id && p.label.toLowerCase() === name.value.toLowerCase());
    if (clash) {
      return { ok: false, code: 'name-in-use', message: `Another drive is already called ${clash.label}. Pick a different name.` };
    }

    const card: DriveCard = { id, name: name.value, createdAt: new Date(this.now()).toISOString(), appVersion: this.appVersion };
    try {
      // T7 write ban: checked here too, so even a replaced card writer cannot reach a protected drive.
      assertWritable(cardPath(this.rootOf(letter)));
    } catch (err) {
      if (err instanceof DriveWriteProtectedError) return { ok: false, code: 'not-allowed', message: `${err.message} Nothing was written.` };
      throw err;
    }
    try {
      this.writeCard(this.rootOf(letter), card);
    } catch (err) {
      if (err instanceof CardExistsError) {
        return { ok: false, code: 'has-card', message: 'This drive already has an ID card. Nothing was changed.' };
      }
      this.log.warn(`places: could not write a card on ${letter}:`, err);
      return {
        ok: false,
        code: 'write-failed',
        message: `Could not write to ${letter}. It may be read-only or write-protected. Nothing else was changed.`,
      };
    }
    this.log.info(`places: wrote drive card "${card.name}" (${card.id}) on ${letter}`);
    if (request.existingPlaceId !== undefined) {
      this.db.prepare('UPDATE places SET label = ? WHERE id = ?').run(name.value, id);
    }
    await this.refresh();
    return { ok: true, placeId: id, name: name.value };
  }

  /** Change a place's display label. For the laptop this also updates this-device.json. */
  renamePlace(id: string, rawLabel: unknown): RenameResult {
    const label = checkLabel(rawLabel, 'name');
    if (!label.ok) return { ok: false, message: label.message };
    const row = this.getRow(id);
    if (!row) return { ok: false, message: 'That place no longer exists.' };
    const clash = this.allRows().find((r) => r.id !== id && r.kind === row.kind && r.label.toLowerCase() === label.value.toLowerCase());
    if (clash) return { ok: false, message: `Another ${row.kind === 'drive' ? 'drive' : 'place'} is already called ${clash.label}.` };
    if (this.device && id === this.device.id) {
      this.device = saveThisDeviceLabel(this.dataDir, this.device, label.value);
    }
    this.db.prepare('UPDATE places SET label = ? WHERE id = ?').run(label.value, id);
    this.publish();
    return { ok: true, label: label.value };
  }
}
