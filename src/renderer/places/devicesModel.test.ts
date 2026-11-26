import { describe, expect, it } from 'vitest';
import type { PlaceView } from '../../shared/places';
import {
  ACCOUNTS_SHOWN,
  accountFacts,
  accountsFold,
  checkNowState,
  accountMatches,
  accountsSummary,
  driveOrder,
  driveSpace,
  driveStripe,
  filterAccounts,
  naturalCompare,
  noAccountMatchText,
  percentTone,
  sortAccounts,
  usableBytes,
  usedOfText,
  usedShare,
} from './devicesModel';

const GB = 1_000_000_000;

function drive(over: Partial<Pick<PlaceView, 'status' | 'capacityBytes' | 'freeBytes' | 'label'>> = {}) {
  return { label: 'T7', status: 'connected' as const, capacityBytes: 1000 * GB, freeBytes: 500 * GB, ...over };
}

function account(label: string, used: number | null, limit: number | null): Pick<PlaceView, 'label' | 'gdrive'> {
  return {
    label,
    gdrive: used === null && limit === null ? null : ({ quotaUsageBytes: used === null ? null : used * GB, quotaLimitBytes: limit === null ? null : limit * GB } as PlaceView['gdrive']),
  };
}

describe('natural order', () => {
  it('reads numbers as numbers and ignores case', () => {
    const names = ['acc10@x.com', 'Acc2@x.com', 'acc1@x.com'];
    expect(names.toSorted(naturalCompare)).toEqual(['acc1@x.com', 'Acc2@x.com', 'acc10@x.com']);
  });
});

describe('drive stripe', () => {
  it('is green when connected and fine', () => {
    expect(driveStripe(drive())).toEqual({ tone: 'ok', word: 'Connected' });
    // Plugged in but Windows cannot read it: amber, and never worded as not connected.
    expect(driveStripe(drive({ status: 'problem' }))).toEqual({ tone: 'amber', word: "Plugged in, can't be read" });
  });
  it('is amber from 85% full and red from 95% full, with a word each', () => {
    expect(driveStripe(drive({ freeBytes: 151 * GB })).tone).toBe('ok');
    expect(driveStripe(drive({ freeBytes: 150 * GB }))).toEqual({ tone: 'amber', word: 'Filling up' });
    expect(driveStripe(drive({ freeBytes: 51 * GB })).tone).toBe('amber');
    expect(driveStripe(drive({ freeBytes: 50 * GB }))).toEqual({ tone: 'crit', word: 'Almost full' });
    expect(driveStripe(drive({ freeBytes: 0 })).tone).toBe('crit');
  });
  it('is grey when not connected, even when full', () => {
    expect(driveStripe(drive({ status: 'disconnected', freeBytes: 0 }))).toEqual({ tone: 'neutral', word: 'Not connected' });
    expect(driveStripe(drive({ status: 'unknown' })).tone).toBe('neutral');
  });
  it('stays green when the size is not known', () => {
    expect(driveStripe(drive({ capacityBytes: null, freeBytes: null })).tone).toBe('ok');
  });
  it('used share is clamped and null without a size', () => {
    expect(usedShare(0, 0)).toBeNull();
    expect(usedShare(null, 10)).toBeNull();
    expect(usedShare(2000, 1000)).toBe(0);
  });
});

describe('drive order and space', () => {
  it('lists connected drives first, each group in natural order', () => {
    const drives = [drive({ label: 'Seagate10', status: 'disconnected' }), drive({ label: 'T7' }), drive({ label: 'Seagate2', status: 'disconnected' }), drive({ label: 'A1' })];
    expect(driveOrder(drives).map((d) => d.label)).toEqual(['A1', 'T7', 'Seagate2', 'Seagate10']);
  });
  it('splits the space into used, free and total', () => {
    expect(driveSpace(drive())).toEqual({ used: '500 GB used', free: '500 GB free', total: '1 TB' });
    expect(driveSpace(drive({ capacityBytes: null, freeBytes: null }))).toEqual({ used: '', free: '', total: '' });
  });
});

describe('account colours', () => {
  it('is green under 70, amber 70 to under 90, red from 90', () => {
    expect(percentTone(0)).toBe('ok');
    expect(percentTone(69)).toBe('ok');
    expect(percentTone(70)).toBe('amber');
    expect(percentTone(89)).toBe('amber');
    expect(percentTone(90)).toBe('crit');
    expect(percentTone(100)).toBe('crit');
  });
  it('reads "4.2 of 15 GB"', () => {
    expect(usedOfText(4.2 * GB, 15 * GB)).toBe('4.2 of 15 GB');
    expect(usedOfText(800_000_000, 15 * GB)).toBe('800 MB of 15 GB');
  });
});

describe('account search', () => {
  const accounts = [account('mum.photos@example.com', 1, 15), account('dad.backup@example.com', 2, 15), account('acc10@x.com', 3, 15)];
  it('matches any typed part, in any case, and everything for empty text', () => {
    expect(accountMatches('dad.backup@example.com', 'dad')).toBe(true);
    expect(accountMatches('dad.backup@example.com', 'BACKUP@EX')).toBe(true);
    expect(accountMatches('dad.backup@example.com', 'mum')).toBe(false);
    expect(accountMatches('x', '   ')).toBe(true);
  });
  it('filters the list', () => {
    expect(filterAccounts(accounts, 'example').map((a) => a.label)).toEqual(['mum.photos@example.com', 'dad.backup@example.com']);
    expect(filterAccounts(accounts, 'zzz')).toEqual([]);
    expect(noAccountMatchText('  zzz ')).toBe('No account matches zzz');
  });
});

describe('account sort', () => {
  const accounts = [account('b10', 10, 15), account('b2', 3, 15), account('none', null, null), account('b1', 12, 15)];
  it('by name in natural order', () => {
    expect(sortAccounts(accounts, 'name').map((a) => a.label)).toEqual(['b1', 'b2', 'b10', 'none']);
  });
  it('by free space, most first, unknown last', () => {
    expect(sortAccounts(accounts, 'free').map((a) => a.label)).toEqual(['b2', 'b10', 'b1', 'none']);
  });
  it('by share used, most first, unknown last', () => {
    expect(sortAccounts(accounts, 'used').map((a) => a.label)).toEqual(['b1', 'b10', 'b2', 'none']);
  });
});

describe('accounts summary', () => {
  it('counts, adds up and keeps the 25% margin', () => {
    const accounts = [account('a', 5, 15), account('b', 14, 15), account('c', null, null)];
    expect(accountFacts(accounts[0]!)).toMatchObject({ freeBytes: 10 * GB, percent: 33 });
    // a: 15 * 0.75 - 5 = 6.25 GB usable; b: 15 * 0.75 - 14 < 0 gives 0.
    expect(usableBytes(accountFacts(accounts[0]!))).toBeCloseTo(6.25 * GB, 0);
    expect(usableBytes(accountFacts(accounts[1]!))).toBe(0);
    expect(accountsSummary(accounts)).toBe('3 accounts · 19 GB used · 11 GB free · 6.3 GB usable after the 25% margin');
  });
  it('says so when there is none', () => {
    expect(accountsSummary([])).toBe('No Google account yet');
    expect(accountsSummary([account('a', 1, 15)])).toContain('1 account ·');
  });
});

describe('the Google accounts fold', () => {
  const many = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
  it('shows the first 8 and offers "Show all 27"', () => {
    expect(ACCOUNTS_SHOWN).toBe(8);
    const folded = accountsFold(many(27), false, false);
    expect(folded.rows).toEqual(many(8));
    expect(folded.foldText).toBe('Show all 27');
  });
  it('shows everything once opened, with "Show fewer"', () => {
    const opened = accountsFold(many(27), true, false);
    expect(opened.rows).toHaveLength(27);
    expect(opened.foldText).toBe('Show fewer');
  });
  it('has no fold for 8 or fewer, or while the person is searching', () => {
    expect(accountsFold(many(8), false, false)).toEqual({ rows: many(8), foldText: null });
    expect(accountsFold(many(27), false, true)).toEqual({ rows: many(27), foldText: null });
  });
});

describe('the Check now button of a card', () => {
  it('is for a plugged-in drive and the laptop only', () => {
    expect(checkNowState({ kind: 'drive', status: 'connected', listing: 'idle' })).toEqual({ show: true, busy: false, text: 'Check now' });
    expect(checkNowState({ kind: 'laptop', status: 'connected', listing: 'idle' }).show).toBe(true);
    expect(checkNowState({ kind: 'drive', status: 'disconnected', listing: 'idle' }).show).toBe(false);
    expect(checkNowState({ kind: 'onedrive', status: 'connected', listing: 'idle' }).show).toBe(false);
    expect(checkNowState({ kind: 'gdrive', status: 'connected', listing: 'idle' }).show).toBe(false);
  });
  it('says "Checking…" and is busy while a check is queued or running', () => {
    expect(checkNowState({ kind: 'drive', status: 'connected', listing: 'running' })).toEqual({ show: true, busy: true, text: 'Checking…' });
    expect(checkNowState({ kind: 'drive', status: 'connected', listing: 'queued' }).busy).toBe(true);
  });
});


describe('Recently added', () => {
  it('puts the newest account first (the list arrives in the order the accounts were added)', () => {
    const a = [{ label: 'old', gdrive: null }, { label: 'mid', gdrive: null }, { label: 'new', gdrive: null }] as never as Parameters<typeof sortAccounts>[0];
    expect(sortAccounts(a, 'recent').map((x) => x.label)).toEqual(['new', 'mid', 'old']);
  });
});
