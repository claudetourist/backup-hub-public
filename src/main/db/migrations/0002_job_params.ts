/**
 * Jobs need to remember what they were asked to do so Retry can create the same job again and a
 * resumed job knows its inputs. Stored as JSON text like the other *_json columns.
 */
export const jobParamsSql = `
ALTER TABLE jobs ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_jobs_kind_finished ON jobs(kind, finished_at);
`;
