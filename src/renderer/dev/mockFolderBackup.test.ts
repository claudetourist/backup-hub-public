import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderBackupCards, FolderBackupProgress, FolderBackupReport, FolderLookResult } from '../../shared/folderBackup';
import { createFolderBackupMock, KEEP_ID, mockOneDriveRows, ONEDRIVE_ID } from './mockFolderBackup';
import { createPhoneBackupMock } from './mockPhoneBackup';

describe('the pretend folder backups for the browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const make = () => {
    const phone = createPhoneBackupMock();
    const folder = createFolderBackupMock(phone.env, phone.handlers);
    return { phone, folder, h: folder.handlers as Record<string, (...args: unknown[]) => Promise<unknown>> };
  };

  it('has about 160 files, the same every time, in the folder form of path', () => {
    const rows = mockOneDriveRows();
    expect(rows.length).toBeGreaterThanOrEqual(150);
    expect(rows.length).toBeLessThanOrEqual(170);
    expect(rows.every((r) => r.path.startsWith('/source/'))).toBe(true);
    expect(rows.some((r) => r.path.endsWith('.pst'))).toBe(true);
    expect(mockOneDriveRows()).toEqual(rows);
  });

  it('answers a look, then a copy that advances (two files are in use), then a report and the copied files', async () => {
    const { h, phone } = make();
    const states: string[] = [];
    phone.subscribe((e) => states.push(e.job.state));
    const look = (await h['folderBackup.look']!(ONEDRIVE_ID)) as { ok: boolean; jobId: number };
    expect(look.ok).toBe(true);
    expect(await h['folderBackup.preview']!(look.jobId)).toBeNull();
    vi.advanceTimersByTime(1000);
    const preview = (await h['folderBackup.preview']!(look.jobId)) as FolderLookResult;
    expect(preview.ok && preview.plan).toMatchObject({ layout: 'dated', alreadyBackedUp: 61_204, onlineOnly: { files: 412 }, movedFiles: 1_204, moved: [{ kind: 'folder_renamed', from: 'Pictures/Trip', to: 'Pictures/Goa 2026' }] });
    if (!preview.ok) return;
    // The saved exclusion (Games) is in its own group, not in the list.
    expect(preview.plan.rows.some((r) => r.path.startsWith('/source/Games/'))).toBe(false);
    expect(preview.plan.leftOut[0]).toMatchObject({ files: 12, rule: { words: 'Never back up: Games (folder)' } });

    const started = (await h['folderBackup.start']!({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] })) as { ok: boolean; jobId: number };
    expect(started.ok).toBe(true);
    const at = async (): Promise<FolderBackupProgress> => (await h['folderBackup.progress']!(started.jobId)) as FolderBackupProgress;
    expect((await at()).finished).toBe(false);
    vi.advanceTimersByTime(600_000);
    const end = await at();
    expect(end).toMatchObject({ finished: true, current: null, waiting: 0, failedCount: 2 });
    const report = (await h['folderBackup.report']!(started.jobId)) as FolderBackupReport;
    expect(report).toMatchObject({ inUseCount: 2, layout: 'dated', onlineOnly: { files: 412 } });
    expect(report.copied.files).toBe(end.done);
    expect(((await h['folderBackup.copied']!(started.jobId)) as { total: number }).total).toBe(end.done);
    expect(states).toContain('done_warnings');
  });

  it('adds the Google Keep notes backup only when asked, then looks and copies it flat', async () => {
    const { h, folder } = make();
    expect(((await h['folderBackup.cards']!()) as FolderBackupCards).keepSync).toEqual({ available: true, exists: false });
    expect(folder.extraRows()).toEqual([]);
    expect(await h['folderBackup.addKeepSync']!()).toMatchObject({ ok: true, backupId: KEEP_ID });
    const cards = (await h['folderBackup.cards']!()) as FolderBackupCards;
    expect(cards.keepSync).toEqual({ available: true, exists: true });
    expect(cards.cards.map((c) => c.layout)).toEqual(['dated', 'flat']);
    expect(folder.extraRows()).toHaveLength(1);
    const look = (await h['folderBackup.look']!(KEEP_ID)) as { jobId: number };
    vi.advanceTimersByTime(1000);
    const preview = (await h['folderBackup.preview']!(look.jobId)) as FolderLookResult;
    expect(preview.ok && preview.plan).toMatchObject({ layout: 'flat', totals: { files: 3 } });
    if (!preview.ok) return;
    const started = (await h['folderBackup.start']!({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] })) as { jobId: number };
    vi.advanceTimersByTime(60_000);
    expect(await h['folderBackup.report']!(started.jobId)).toMatchObject({ copied: { files: 3 }, layout: 'flat' });
  });

  it('keeps the OneDrive exclusions of its own and hands every other backup to the phone answers', async () => {
    const { h } = make();
    expect(await h['rules.list']!(ONEDRIVE_ID)).toMatchObject({ ok: true, rules: [{ words: 'Never back up: Games (folder)' }] });
    expect(await h['rules.add']!({ backupId: ONEDRIVE_ID, scope: 'pattern', pattern: '*.sav', choice: 'leave_out' })).toMatchObject({ ok: true, added: true });
    expect(await h['rules.list']!(1)).toMatchObject({ ok: true, backupName: 'Poco F4' });
  });
});
