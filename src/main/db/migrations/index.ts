import { initialSql } from './0001_initial';
import { jobParamsSql } from './0002_job_params';
import { filesCatalogSql } from './0003_files_catalog';
import { listingSql } from './0004_listing';
import { fingerprintsSql } from './0005_fingerprints';
import { jobPauseSql } from './0006_job_pause';
import { coverageIndexesSql } from './0007_coverage_indexes';
import { driveSyncSql } from './0008_drive_sync';
import { fileKindSql } from './0009_file_kind';
import { fastStartSql } from './0010_fast_start';
import { reviewSql } from './0011_review';
import { reclassifyOtherSql } from './0012_reclassify_other';
import { nameOrderSql } from './0013_name_order';
import { cleanupSql } from './0014_cleanup';
import { sharedWithMeSql } from './0015_shared_with_me';
import { emptyFilesSql } from './0016_empty_files';
import { plansSql } from './0017_plans';
import { startSql } from './0018_start';
import { startSpeedSql } from './0019_start_speed';
import { backupProfilesSql } from './0020_backup_profiles';
import { dangerSql } from './0021_danger';
import { destinationPositionSql } from './0022_destination_position';
import { backupRulesSql } from './0023_backup_rules';
import { fileIdsSql } from './0024_file_ids';
import { backupArchiveSql } from './0025_backup_archive';
import { searchIndexSql } from './0026_search_index';
import { phoneKeepSql } from './0028_phone_keep';

export interface Migration {
  /** Strictly increasing, starting at 1, no gaps. */
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only list. Never edit a migration that has shipped; add the next version instead.
 * SQL is embedded as TS strings so the Vite bundle needs no extra files.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: initialSql },
  { version: 2, name: 'job_params', sql: jobParamsSql },
  { version: 3, name: 'files_catalog', sql: filesCatalogSql },
  { version: 4, name: 'listing', sql: listingSql },
  { version: 5, name: 'fingerprints', sql: fingerprintsSql },
  { version: 6, name: 'job_pause', sql: jobPauseSql },
  { version: 7, name: 'coverage_indexes', sql: coverageIndexesSql },
  { version: 8, name: 'drive_sync', sql: driveSyncSql },
  { version: 9, name: 'file_kind', sql: fileKindSql },
  { version: 10, name: 'fast_start', sql: fastStartSql },
  { version: 11, name: 'review', sql: reviewSql },
  { version: 12, name: 'reclassify_other', sql: reclassifyOtherSql },
  { version: 13, name: 'name_order', sql: nameOrderSql },
  { version: 14, name: 'cleanup', sql: cleanupSql },
  { version: 15, name: 'shared_with_me', sql: sharedWithMeSql },
  { version: 16, name: 'empty_files', sql: emptyFilesSql },
  { version: 17, name: 'plans', sql: plansSql },
  { version: 18, name: 'start', sql: startSql },
  { version: 19, name: 'start_speed', sql: startSpeedSql },
  { version: 20, name: 'backup_profiles', sql: backupProfilesSql },
  { version: 21, name: 'danger', sql: dangerSql },
  { version: 22, name: 'destination_position', sql: destinationPositionSql },
  { version: 23, name: 'backup_rules', sql: backupRulesSql },
  { version: 24, name: 'file_ids', sql: fileIdsSql },
  { version: 25, name: 'backup_archive', sql: backupArchiveSql },
  { version: 26, name: 'search_index', sql: searchIndexSql },
  // 27 was reserved for Google copy, which needed no migration: a no-op keeps the list gap-free.
  { version: 27, name: 'reserved_google', sql: 'SELECT 1;' },
  { version: 28, name: 'phone_keep', sql: phoneKeepSql },
];
