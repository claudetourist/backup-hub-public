import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckOldCountsResult, CheckOldPlanResult, CheckOldReport } from '../../shared/phoneBackup';
import { createPhoneBackupMock } from './mockPhoneBackup';

describe('the pretend "Check old copies" for the browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the Poco numbers, a preview with unchecked folders, a check that advances, and a report with 2 that differ and 1 missing', async () => {
    const mock = createPhoneBackupMock();
    const h = mock.handlers as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const states: string[] = [];
    const messages: string[] = [];
    mock.subscribe((e) => {
      states.push(e.job.state);
      if (e.job.kind === 'phone.checkOld' && e.job.message) messages.push(e.job.message);
    });
    const before = (await h['phoneBackup.checkOldCounts']!(1)) as Extract<CheckOldCountsResult, { ok: true }>;
    expect(before.total.onPhone.files).toBe(33_721);
    expect(before.total.checked.files).toBe(12_345);
    expect(before.total.unchecked.files).toBeGreaterThan(10_000);
    const plan = (await h['phoneBackup.checkOldPlan']!(1)) as Extract<CheckOldPlanResult, { ok: true }>;
    expect(plan.folders.length).toBeGreaterThanOrEqual(3);
    expect(plan.folders.map((f) => f.bytes)).toEqual(plan.folders.map((f) => f.bytes).toSorted((a, b) => b - a));
    expect(await h['phoneBackup.checkOldReport']!(9003)).toBeNull();

    const started = (await h['phoneBackup.checkOldStart']!({ backupId: 1, folders: plan.folders.map((f) => f.folder) })) as { ok: boolean; jobId: number };
    expect(started).toMatchObject({ ok: true, jobId: 9003 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(messages.some((m) => /^Checked [\d,]+ of [\d,]+ \(/.test(m))).toBe(true);
    expect(states).not.toContain('done_warnings');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states.at(-1)).toBe('done_warnings');
    const report = (await h['phoneBackup.checkOldReport']!(9003)) as CheckOldReport;
    expect(report).toMatchObject({ differCount: 2, missingCount: 1, driveLabel: 'T7' });
    expect(report.differ).toHaveLength(2);
    const after = (await h['phoneBackup.checkOldCounts']!(1)) as Extract<CheckOldCountsResult, { ok: true }>;
    expect(after.total.checked.files).toBeGreaterThan(before.total.checked.files);
    expect(after.total.unchecked.files).toBe(0);
    expect(after.total.onPhone.files).toBe(33_721);
    expect(await h['phoneBackup.checkOldPlan']!(1)).toMatchObject({ ok: false });
  });
});
