import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { progressPercent, type JobRecord } from '../../shared/jobs';
import { jobPercent, progressLine } from '../backups/backupListModel';
import { jobRowLine } from '../jobs/jobsModel';
import { ProgressPanel } from './ProgressPanel';
import { amountText, filesAlongside, percentDone, progressInputOf, wholePercent } from './progressModel';

type Progress = Pick<JobRecord, 'bytesDone' | 'bytesTotal' | 'progressDone' | 'progressTotal' | 'speed' | 'startedAt' | 'pausedMs'>;
const job = (p: Partial<Progress>): Progress => ({ bytesDone: 0, bytesTotal: 0, progressDone: 0, progressTotal: 0, speed: null, startedAt: null, pausedMs: 0, ...p });

/** One job, one percentage: the bar of the progress panel, the header bar of the backup page, the sidebar and the jobs list all take it from the same measure. */
describe('every bar of one job shows the same percent', () => {
  const GB = 1_000_000_000;
  const jobs: Record<string, Progress> = {
    // freeup.remove: 247 of 419 files looked at, 31 of 46.2 GB removed (the files before it were small, the videos come first)
    'freeup.remove (bytes known)': job({ progressDone: 247, progressTotal: 419, bytesDone: 31 * GB, bytesTotal: 46.2 * GB }),
    'freeup.remove, a skipped file': job({ progressDone: 400, progressTotal: 419, bytesDone: 41.9 * GB, bytesTotal: 46.2 * GB }),
    'freeup.check (files only)': job({ progressDone: 1234, progressTotal: 5000 }),
    'phone.backup (bytes and files)': job({ progressDone: 3, progressTotal: 9, bytesDone: 7, bytesTotal: 9 }),
    'a sum that floats low (29 of 100)': job({ bytesDone: 29, bytesTotal: 100, progressDone: 1, progressTotal: 2 }),
    'a job with no totals': job({}),
    'done': job({ progressDone: 10, progressTotal: 10, bytesDone: 5, bytesTotal: 5 }),
  };

  it.each(Object.entries(jobs))('%s', (_name, j) => {
    const panel = percentDone(progressInputOf(j, 1_000));
    const header = jobPercent(j);
    expect(panel === null ? null : wholePercent(panel)).toBe(header);
    expect(header).toBe(progressPercent(j) === null ? null : Math.floor(progressPercent(j)!));
    // the sidebar line and the jobs list say the same whole number
    const record = { ...j, id: 1, kind: 'freeup.remove', title: 'Free up space', state: 'running', message: null, warnings: [], error: null, paused: false, choices: [], createdAt: 0, finishedAt: null, hasCheckpoint: false, etaSeconds: null } as unknown as JobRecord;
    if (header !== null) {
      expect(jobRowLine(record, [record])).toContain(`${header}%`);
      expect(progressLine({ kind: 'phone', driveLabel: 'T7', destinations: [] }, record)).toContain(`${header}%`);
    }
  });

  it('the panel of a removal counts bytes, and says the files in plain text next to it', () => {
    const j = jobs['freeup.remove (bytes known)']!;
    const input = progressInputOf(j, 1_000);
    expect(input.totalBytes).toBe(46.2 * GB);
    expect(filesAlongside(input)).toBe('247 of 419 files');
    const html = renderToStaticMarkup(h(ProgressPanel, { what: 'Freeing space', onPause: () => undefined, onResume: () => undefined, onStop: () => undefined, ...input }));
    expect(html).toContain('31 GB of 46.2 GB, 67%, 247 of 419 files');
    expect(html).toContain('aria-valuenow="67"');
  });

  it('a job that counts files only keeps the files as its amount and shows no second files line; a zero byte total is not "0 B of 0 B"', () => {
    const input = progressInputOf(jobs['freeup.check (files only)']!, 1_000);
    expect(input.filesOnly).toBe(true);
    expect(amountText(input)).toBe('1,234 of 5,000 files');
    expect(filesAlongside(input)).toBeNull();
    expect(amountText({ doneBytes: 0, totalBytes: 0, doneFiles: 3, totalFiles: 9 })).toBe('3 of 9 files');
    expect(percentDone({ doneBytes: 0, totalBytes: 0, doneFiles: 3, totalFiles: 9 })).toBeCloseTo(33.33, 1);
  });
});
