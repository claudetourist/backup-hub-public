import type { PlaceCoverage } from '../../shared/fingerprint';
import type { PlaceFileStats } from '../../shared/listing';
import type { SearchRequest, SearchResponse } from '../../shared/search';
import type { FingerprintCounts } from '../copies/copiesIndex';
import type { MigrationResult } from '../db/migrate';
import type { CheckOldCountsResult } from '../../shared/phoneBackup';
import type { MirrorCountPair } from '../mirror/mirrorTypes';
import type { Behind as MirrorBehind } from '../mirror/mirrorScan';
import type { BackupSize } from '../../shared/backups';
import type { IndexProgress } from './searchIndexFill';
import type { OnlyHereSummary, WouldLoseDetail, WouldLoseFilesPage, WouldLoseFilesRequest } from '../../shared/insights';

/** Messages between the main process and the query worker (plain data only). */
export type QueryOp = 'coverage' | 'stats' | 'quickCheck' | 'fullCheck' | 'search' | 'migrate' | 'checkOldCounts' | 'mirrorBehind' | 'backupSizes' | 'indexKeep' | 'indexStop' | 'indexPause' | 'wouldLose';

export interface QueryRequest {
  id: number;
  op: QueryOp;
  /** Absolute path of the database file; the worker opens its OWN read-only connection to it (op 'migrate': its own read-write one). */
  dbFile: string;
  /** Only for op 'search'. */
  search?: SearchRequest;
  /** Only for op 'checkOldCounts'. */
  backupId?: number;
  /** Only for op 'indexPause': true = stop filling the search index for now (a job is running), false = go on. */
  paused?: boolean;
  /** Only for op 'mirrorBehind': where the first and the second drive's backup folders are in the index. */
  mirror?: MirrorCountPair;
  /** Only for op 'backupSizes': each backup's first drive and backup folder. */
  sizes?: BackupSizeAsk[];
  /** Only for op 'wouldLose': one place (its files without a checked copy, by kind and folder), or null (the one-line summary of every place). */
  lose?: { placeId: string | null; /** A page of the files (biggest first) instead of the counts. */ files?: WouldLoseFilesRequest };
}

/** One backup to be sized: its first drive's place and the backup folder on it ("MyData/POCO"). */
export interface BackupSizeAsk {
  backupId: number;
  placeId: string;
  root: string;
}

export interface CoverageResult {
  byPlace: [string, PlaceCoverage][];
}

export interface StatsResult {
  files: [string, PlaceFileStats][];
  fingerprint: [string, FingerprintCounts][];
  /** The first reason a file of each place could not be read. */
  failReasons: [string, string][];
}

export interface QuickCheckResult {
  ok: boolean;
  messages: string[];
}

export type QueryResultOf<O extends QueryOp> = O extends 'coverage' ? CoverageResult : O extends 'stats' ? StatsResult : O extends 'search' ? SearchResponse : O extends 'migrate' ? MigrationResult : O extends 'checkOldCounts' ? CheckOldCountsResult : O extends 'mirrorBehind' ? MirrorBehind : O extends 'backupSizes' ? BackupSize[] : O extends 'wouldLose' ? WouldLoseDetail | OnlyHereSummary[] | WouldLoseFilesPage : QuickCheckResult;

/** What the worker that keeps the search index (op 'indexKeep') says: where the index is (null = this database has no index), or why it stopped. */
export type IndexReply = { type: 'index'; progress: IndexProgress | null } | { type: 'indexFailed'; message: string };

export type QueryReply =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; result: CoverageResult | StatsResult | QuickCheckResult | SearchResponse | MigrationResult | CheckOldCountsResult | MirrorBehind | BackupSize[] | WouldLoseDetail | OnlyHereSummary[] | WouldLoseFilesPage; ms: number }
  | { type: 'result'; id: number; ok: false; message: string };
