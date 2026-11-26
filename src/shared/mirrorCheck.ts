/**
 * "Check old copies on <second drive>" (R1.3b): the files that are already on the second drive with the same size (old copies of an older tool) are
 * PROVEN, in a job of their own, after the copy job has brought the missing files over. The copy job never reads them. Types, constants and the
 * time guess only; main and the window share them. Words for the screens live in renderer/backups/mirrorModel.ts.
 */
import type { ReasonLine } from './phoneBackup';

/** The heavy resumable job that reads same-size files on the second drive (and on the first only when its checksum is not known). */
export const MIRROR_CHECK_JOB_KIND = 'mirror.checkOld';

/** Photos and videos first, then documents, then the rest: a stop part-way has the valuable files proven. */
export type MirrorCheckGroup = 'photos' | 'documents' | 'other';
export const MIRROR_CHECK_GROUPS: readonly MirrorCheckGroup[] = ['photos', 'documents', 'other'];
export const MIRROR_CHECK_GROUP_WORDS: Record<MirrorCheckGroup, string> = { photos: 'photos and videos', documents: 'documents', other: 'other files' };

const PHOTO_EXT = new Set(['jpg', 'jpeg', 'heic', 'png', 'mp4', 'mov']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'odt', 'ods', 'odp', 'rtf', 'csv', 'epub']);
const PHOTO_FOLDERS = new Set(['dcim', 'camera', 'pictures', 'whatsapp images', 'whatsapp video']);
const DOC_FOLDERS = new Set(['documents', 'download']);

/** Which group a path inside the backup folder belongs to: the folder first (DCIM, Camera, Pictures, WhatsApp Images / Video), then the ending. */
export function checkGroupOf(rel: string): MirrorCheckGroup {
  const parts = rel.toLowerCase().split('/');
  const name = parts[parts.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1);
  for (let i = 0; i < parts.length - 1; i += 1) if (PHOTO_FOLDERS.has(parts[i]!)) return 'photos';
  if (PHOTO_EXT.has(ext)) return 'photos';
  if (DOC_EXT.has(ext)) return 'documents';
  for (let i = 0; i < parts.length - 1; i += 1) if (DOC_FOLDERS.has(parts[i]!)) return 'documents';
  return 'other';
}

export interface MirrorCheckCount {
  files: number;
  bytes: number;
}

/**
 * A rough guess of the time, from the file list alone. The second drive is a spinning disk read without the Windows cache: about 80 MB/s and about
 * 80 ms of waiting per file; a first-drive file that has to be read as well adds half of its own (smaller) cost, because both are read at the same time.
 * The real figure shows after a few minutes of running.
 */
export const CHECK_DISK_BYTES_PER_SECOND = 80e6;
export const CHECK_SECONDS_PER_FILE = 0.08;
export function estimateCheckSeconds(all: MirrorCheckCount, firstDriveToRead: MirrorCheckCount): number {
  const second = all.files * CHECK_SECONDS_PER_FILE + all.bytes / CHECK_DISK_BYTES_PER_SECOND;
  const first = 0.5 * (firstDriveToRead.files * 0.02 + firstDriveToRead.bytes / 150e6);
  return Math.ceil(second + first);
}

export interface MirrorCheckPlanBackup {
  backupId: number;
  backupName: string;
  sourceLabel: string;
  targetLabel: string;
  files: number;
  bytes: number;
}

export interface MirrorCheckPlanView {
  planId: string;
  hash: string;
  backups: MirrorCheckPlanBackup[];
  totals: MirrorCheckCount;
  /** In the order they are checked. */
  groups: { group: MirrorCheckGroup; files: number; bytes: number }[];
  /** Files whose first-drive checksum is known (the phone's, or proven earlier): only the second drive's file is read. */
  oneRead: MirrorCheckCount;
  /** Files whose first-drive checksum is not known: both files are read. */
  twoReads: MirrorCheckCount;
  /** Already proven earlier or already asked about: not in this check. */
  alreadyChecked: number;
  estimateSeconds: number;
  notes: string[];
}

export type MirrorCheckPreviewResult = { ok: true; plan: MirrorCheckPlanView } | { ok: false; message: string };

export interface MirrorCheckSelection {
  planId: string;
  hash: string;
}

export interface MirrorCheckReportBackup {
  backupId: number;
  backupName: string;
  targetLabel: string;
  /** Same checksum: the second drive's file is now a verified copy. */
  verified: number;
  /** Another checksum: never replaced, in "Needs your decision". */
  differs: number;
  skipped: number;
  failed: number;
}

export interface MirrorCheckReport {
  jobId: number;
  startedAt: number;
  finishedAt: number;
  /** False when the job was stopped part-way (what is in the report is what was proven; nothing is lost). */
  complete: boolean;
  backups: MirrorCheckReportBackup[];
  verified: number;
  differs: number;
  /** Files proven with one read (the first drive's checksum was known) and with two. */
  oneRead: number;
  twoReads: number;
  groups: { group: MirrorCheckGroup; done: number; total: number }[];
  skipped: ReasonLine[];
  failed: ReasonLine[];
  usbPauses: number;
}
