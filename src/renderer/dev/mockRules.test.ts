import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhoneLookResult } from '../../shared/phoneBackup';
import type { NotCoveredResult, RuleAddResult, RuleEffectResult, RulesListResult } from '../../shared/rules';
import { createPhoneBackupMock, mockPreviewRows } from './mockPhoneBackup';
import { MOCK_SAVED_FOLDER } from './mockRules';

describe('the pretend choices for the browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const handlers = (): Record<string, (...args: unknown[]) => Promise<unknown>> => createPhoneBackupMock().handlers as Record<string, (...args: unknown[]) => Promise<unknown>>;

  it('has a Status folder in the list, one saved choice with its own group, and two of five things ticked', async () => {
    expect(mockPreviewRows().filter((r) => r.path.includes('/.Statuses/')).length).toBeGreaterThanOrEqual(5);
    const mock = createPhoneBackupMock();
    const h = mock.handlers as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const look = (await h['phoneBackup.look']!()) as { jobId: number };
    vi.advanceTimersByTime(800);
    const preview = (await h['phoneBackup.preview']!(look.jobId)) as PhoneLookResult;
    if (!preview.ok) throw new Error('no plan');
    const group = preview.plan.leftOut.find((g) => g.rule !== undefined)!;
    expect(group).toMatchObject({ key: 'rule:1', files: 31, canInclude: false, rule: { id: 1, words: 'Never back up: Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses (folder)' } });
    expect(preview.plan.leftOut.filter((g) => g.canInclude)).toHaveLength(2);
    expect(mock.choices()).toBe(1);
    const list = (await h['rules.list']!(1)) as Extract<RulesListResult, { ok: true }>;
    expect(list.rules).toMatchObject([{ id: 1, pattern: MOCK_SAVED_FOLDER, choice: 'leave_out' }]);
    const card = (await h['rules.notCovered']!(1)) as Extract<NotCoveredResult, { ok: true }>;
    expect([card.done, card.total]).toEqual([2, 5]);
  });

  it('saving, counting and removing work on the pretend state; ticking too', async () => {
    const h = handlers();
    const folder = '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/.Statuses';
    const inFolder = mockPreviewRows().filter((r) => r.path.startsWith(folder + '/'));
    const effect = (await h['rules.effect']!({ backupId: 1, change: { kind: 'add', draft: { scope: 'folder', pattern: folder, choice: 'leave_out' } } })) as Extract<RuleEffectResult, { ok: true }>;
    expect(effect).toMatchObject({ hasPlan: true, leavesOut: { files: inFolder.length, bytes: inFolder.reduce((n, r) => n + r.size, 0) }, bringsBack: { files: 0 } });
    const saved = (await h['rules.add']!({ backupId: 1, scope: 'folder', pattern: folder + '/', choice: 'leave_out' })) as Extract<RuleAddResult, { ok: true }>;
    expect(saved).toMatchObject({ added: true, count: 2, rule: { pattern: folder } });
    expect(await h['rules.add']!({ backupId: 1, scope: 'folder', pattern: folder, choice: 'leave_out' })).toMatchObject({ added: false, count: 2 });
    expect(await h['rules.remove']!({ backupId: 1, ruleId: saved.rule.id, confirmed: true })).toMatchObject({ ok: true, count: 1 });
    expect(await h['rules.remove']!({ backupId: 1, ruleId: saved.rule.id, confirmed: true })).toMatchObject({ ok: false });
    const ticked = (await h['rules.tickNotCovered']!({ backupId: 1, item: 'signal', ticked: true })) as Extract<NotCoveredResult, { ok: true }>;
    expect(ticked.done).toBe(3);
    expect(((await h['rules.tickNotCovered']!({ backupId: 1, item: 'signal', ticked: false })) as Extract<NotCoveredResult, { ok: true }>).done).toBe(2);
  });
});
