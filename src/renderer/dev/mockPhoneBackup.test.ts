import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhoneBackupProgress, PhoneBackupReport, PhoneLookResult } from '../../shared/phoneBackup';
import { createPhoneBackupMock, mockPreviewRows } from './mockPhoneBackup';

describe('the pretend phone backup for the browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('has about 230 files: big videos in DCIM/Camera, many small WhatsApp files, the same every time', () => {
    const rows = mockPreviewRows();
    expect(rows.length).toBeGreaterThanOrEqual(220);
    expect(rows.length).toBeLessThanOrEqual(240);
    expect(rows.filter((r) => r.path.startsWith('/sdcard/DCIM/Camera/') && r.path.endsWith('.mp4') && r.size >= 30_000_000).length).toBeGreaterThanOrEqual(10);
    expect(rows.filter((r) => r.path.includes('WhatsApp') && r.size < 400_000).length).toBeGreaterThanOrEqual(80);
    expect(rows.some((r) => r.kind === 'changed')).toBe(true);
    expect(new Set(rows.map((r) => r.path)).size).toBe(rows.length);
    expect(mockPreviewRows()).toEqual(rows);
  });

  it('answers a look, then a copy whose progress advances, then a report and the copied files', async () => {
    const mock = createPhoneBackupMock();
    const h = mock.handlers as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const events: string[] = [];
    mock.subscribe((e) => events.push(e.job.state));
    expect(await h['phoneBackup.preview']!(9001)).toBeNull();
    const look = (await h['phoneBackup.look']!()) as { ok: boolean; jobId: number };
    expect(look.ok).toBe(true);
    vi.advanceTimersByTime(800);
    const preview = (await h['phoneBackup.preview']!(look.jobId)) as PhoneLookResult;
    expect(preview.ok && preview.plan.rows.length).toBeGreaterThanOrEqual(220);
    if (!preview.ok) return;

    const started = (await h['phoneBackup.start']!({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [preview.plan.rows[0]!.path], untickedFolders: [], included: [] })) as { ok: boolean; jobId: number };
    expect(started.ok).toBe(true);
    const at = async (): Promise<PhoneBackupProgress> => (await h['phoneBackup.progress']!(started.jobId)) as PhoneBackupProgress;
    const first = await at();
    expect(first).toMatchObject({ total: preview.plan.rows.length - 1, done: 0, finished: false });
    expect(first.current).not.toBeNull();
    vi.advanceTimersByTime(20_000);
    const later = await at();
    expect(later.done).toBeGreaterThan(first.done);
    expect(later.waiting).toBeLessThan(first.waiting);
    expect(later.recent.length).toBeGreaterThan(0);
    expect(await h['phoneBackup.report']!(started.jobId)).toBeNull();

    vi.advanceTimersByTime(600_000);
    const end = await at();
    expect(end).toMatchObject({ finished: true, current: null, waiting: 0, failedCount: 2 });
    expect(end.failed.every((f) => f.reason.length > 0)).toBe(true);
    const report = (await h['phoneBackup.report']!(started.jobId)) as PhoneBackupReport;
    expect(report.copied.files).toBe(end.done);
    const copied = (await h['phoneBackup.copied']!(started.jobId)) as { total: number };
    expect(copied.total).toBe(end.done);
    expect(events).toContain('done_warnings');
    expect(mock.jobs().map((j) => j.id)).toContain(9002);
    // Another unknown job answers nothing.
    expect(await h['phoneBackup.progress']!(1)).toBeNull();
  });
});
