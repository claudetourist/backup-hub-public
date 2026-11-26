import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionCase } from '../../shared/decisions';
import type { JobRecord } from '../../shared/jobs';
import type { MirrorCheckPreviewResult } from '../../shared/mirrorCheck';
import type { MirrorLookResult, MirrorReport, MirrorStatusResult } from '../../shared/mirror';
import { createMirrorMock, mockMirrorRows } from './mockMirror';
import { createPhoneBackupMock } from './mockPhoneBackup';

describe('the pretend second drive for the browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('has about 140 files, big videos first, the same every time', () => {
    const rows = mockMirrorRows();
    expect(rows.length).toBeGreaterThanOrEqual(130);
    expect(rows.length).toBeLessThanOrEqual(150);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.some((r) => r.ownChecksum)).toBe(true);
    expect(mockMirrorRows()).toEqual(rows);
  });

  it('adds the second drive, looks, copies with one USB pause that waits for Continue, and ends with a report and two cases to decide', async () => {
    const phone = createPhoneBackupMock();
    const decisions: DecisionCase[] = [];
    const mock = createMirrorMock({ ...phone.env, addDecision: (c) => decisions.push(c) });
    const h = mock.handlers as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const states: string[] = [];
    phone.subscribe((e) => states.push(e.job.state));

    expect(((await h['mirror.status']!()) as MirrorStatusResult).backups.map((b) => b.backupId)).toEqual([2]);
    expect(mock.row({ id: 1 } as never).destinations).toHaveLength(1);
    expect((await h['mirror.choices']!(1)) as { ok: boolean }).toMatchObject({ ok: true });
    expect(await h['mirror.add']!({ backupId: 1 })).toMatchObject({ ok: true });
    expect(await h['mirror.add']!({ backupId: 1 })).toMatchObject({ ok: false });
    expect(mock.row({ id: 1 } as never).destinations).toHaveLength(2);
    const before = (await h['mirror.status']!()) as MirrorStatusResult;
    expect(before.backups[0]!.mirrors[0]!.behindFiles).toBeGreaterThan(100);

    expect(await h['mirror.preview']!(9101)).toBeNull();
    const look = (await h['mirror.look']!()) as { ok: boolean; jobId: number };
    expect(look.ok).toBe(true);
    vi.advanceTimersByTime(800);
    const preview = (await h['mirror.preview']!(look.jobId)) as MirrorLookResult;
    expect(preview.ok && preview.plan.rows.length).toBeGreaterThan(100);
    if (!preview.ok) return;
    expect(preview.plan.different.files).toBe(2);

    const started = (await h['mirror.start']!({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [preview.plan.rows[0]!.id] })) as { ok: boolean; jobId: number };
    expect(started.ok).toBe(true);
    // It runs until half way, then waits for Continue with the plain message.
    vi.advanceTimersByTime(400 * 55);
    const waiting = phone.jobs().find((j: JobRecord) => j.id === started.jobId)!;
    expect(waiting.state).toBe('needs_you');
    expect(waiting.message).toContain('had a USB problem. Plug it straight into the laptop, not a hub, then press Continue.');
    await h['jobs.resolve']!(started.jobId);
    vi.advanceTimersByTime(400 * 70);
    expect(phone.jobs().find((j: JobRecord) => j.id === started.jobId)!.state).toBe('done_warnings');
    const report = (await h['mirror.report']!(started.jobId)) as MirrorReport;
    expect(report).toMatchObject({ damaged: 1, different: 2, usbPauses: 1 });
    expect(report.copied.files).toBe(preview.plan.rows.length - 2);
    expect(decisions.map((c) => c.source)).toEqual(['mirror', 'mirror']);
    expect(states).toContain('needs_you');
    const after = (await h['mirror.status']!()) as MirrorStatusResult;
    expect(after.backups[0]!.mirrors[0]).toMatchObject({ behindFiles: 1, needYou: 1 });
  });

  it('"Check old copies": a preview with the groups, reads and a time, then a check that says how far it is and ends with a report', async () => {
    const phone = createPhoneBackupMock();
    const mock = createMirrorMock({ ...phone.env, addDecision: () => undefined });
    const h = mock.handlers as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const preview = (await h['mirror.checkPreview']!()) as MirrorCheckPreviewResult;
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.plan.totals.files).toBe(40_940);
    expect(preview.plan.groups.map((g) => g.group)).toEqual(['photos', 'documents', 'other']);
    expect(preview.plan.oneRead.files + preview.plan.twoReads.files).toBe(40_940);
    expect(preview.plan.estimateSeconds).toBeGreaterThan(3600);
    const started = (await h['mirror.checkStart']!({ planId: preview.plan.planId, hash: preview.plan.hash })) as { ok: boolean; jobId: number };
    expect(started.ok).toBe(true);
    vi.advanceTimersByTime(400 * 3);
    const running = phone.jobs().find((j: JobRecord) => j.id === started.jobId)!;
    expect(running.kind).toBe('mirror.checkOld');
    expect(running.message).toBe('Checked so far: photos and videos 2,700 of 18,000 · documents 0 of 2,300 · other files 0 of 20,640');
    expect(running.bytesTotal).toBe(0);
    expect(await h['mirror.checkReport']!(started.jobId)).toBeNull();
    vi.advanceTimersByTime(400 * 50);
    expect(phone.jobs().find((j: JobRecord) => j.id === started.jobId)!.state).toBe('done_warnings');
    expect(await h['mirror.checkReport']!(started.jobId)).toMatchObject({ complete: true, verified: 40_938, differs: 2 });
  });
});
