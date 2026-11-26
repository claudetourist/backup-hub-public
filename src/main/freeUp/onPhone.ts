/**
 * "Is this file still on the phone?" for a copy on a drive, by the SAME rule Free up phone space uses (freeUpCheck.ts reads the phone backup's
 * place in the file list, live rows only, size above 0, and finds each file's drive copy by its link `origin_file_id`, else by SHA-256 + size).
 * Seen from the drive copy's side that is: a live row of the phone's place that the copy links to, or that has the same SHA-256 and size.
 * The phone's place (`backup_profiles.source_place_id`) is where the listing of the phone is kept: a file gone from the phone has `gone_at` set.
 * Read only; a query fragment, so the caller's paged, sliced statements can use it. The parameter `@phone` is the phone's place id.
 */

/** The condition on a drive row (its alias in the caller's query): its content is still on the phone. Needs the named parameter @phone. */
export const stillOnPhoneSql = (alias: string): string =>
  `(EXISTS (SELECT 1 FROM files p WHERE p.id = ${alias}.origin_file_id AND p.place_id = @phone AND p.gone_at IS NULL AND p.size > 0)
   OR (${alias}.sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM files p INDEXED BY idx_files_sha256_live WHERE p.sha256 = ${alias}.sha256 AND p.place_id = @phone AND p.size = ${alias}.size AND p.gone_at IS NULL)))`;
