/**
 * R1.0a (23 Nov 2026): the order of a backup's destinations. 1 = copied from the source, 2 = mirrored from 1, and so on. Additive only:
 * one new column on `backup_destinations`; every existing row (and every row inserted without it) is 1. Nothing else changes.
 */
export const destinationPositionSql = `
ALTER TABLE backup_destinations ADD COLUMN position INTEGER NOT NULL DEFAULT 1;
`;
