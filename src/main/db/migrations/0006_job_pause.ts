/**
 * Per-job pause (P4b-3): `jobs.paused` is 1 while the user has paused a job. A paused job is kept
 * in the 'queued' state (the six job states do not change); the runner skips it until it is
 * resumed, so a job paused before the app closed stays paused after it starts again.
 */
export const jobPauseSql = `
ALTER TABLE jobs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
`;
