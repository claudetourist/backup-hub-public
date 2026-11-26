import { describe, expect, it } from 'vitest';
import type { DriveHealth, LoseSection, WouldLoseDetail } from '../../shared/insights';
import type { PlaceView } from '../../shared/places';
import { checkText, errorsText, homeLoseItems, kindLabel, loseChoices, loseHeadline, losePlaceOf, loseSub, seenText, verdictTone } from './insightsModel';

const NOW = new Date(2026, 10, 26, 12).getTime();
const DAY = 86_400_000;
const place = (over: Partial<PlaceView>): PlaceView => ({ id: 'x', kind: 'drive', label: 'X', ...over }) as PlaceView;
const section = (files: number, bytes: number): LoseSection => ({ files, bytes, kinds: [], byBackup: [] });
const detail = (only: [number, number], maybe: [number, number], total: number): WouldLoseDetail => ({ placeId: 't7', onlyHere: section(...only), maybeCopied: section(...maybe), notChecked: { files: 0, bytes: 0 }, totalFiles: total });

describe('the address of the lose screen', () => {
  it('is a section of Devices that carries the place, and survives odd ids', () => {
    expect(loseSub('t7')).toBe('lose:t7');
    expect(losePlaceOf(loseSub('drive/a b'))).toBe('drive/a b');
    expect(losePlaceOf(null)).toBeNull();
    expect(losePlaceOf('lose:')).toBeNull();
    expect(losePlaceOf('tools')).toBeNull();
  });
});

describe('verdict words and lines', () => {
  it('colours: healthy green, check soon amber, problem red', () => {
    expect(['healthy', 'check-soon', 'problem'].map((v) => verdictTone(v as 'healthy'))).toEqual(['ok', 'amber', 'crit']);
  });

  it('says when a place was seen, and the last check in few words', () => {
    const h = (over: Partial<DriveHealth>): DriveHealth => ({ status: 'disconnected', lastSeenAt: NOW - 17 * DAY, kind: 'drive', ...over }) as DriveHealth;
    expect(seenText(h({ status: 'connected' }), NOW)).toBe('Connected now');
    expect(seenText(h({}), NOW)).toBe('9 Nov, 17 days ago');
    expect(seenText(h({ lastSeenAt: null }), NOW)).toBe('Never seen');
    expect(checkText(null, NOW)).toBe('Never checked');
    expect(checkText({ at: NOW - 3 * DAY, verified: 1000, differs: 2, couldNotRead: 1, complete: false }, NOW)).toBe('23 Nov: 1,000 the same, 2 different, 1 could not be read (stopped early)');
  });

  it('errors: "None" when clean, else each count in words', () => {
    expect(errorsText({ windowsErrors: 0, usbTroubles: 0, readErrors: 0, damaged: 0 })).toBe('None');
    expect(errorsText({ windowsErrors: null, usbTroubles: 0, readErrors: 0, damaged: 0 })).toBe('None');
    expect(errorsText({ windowsErrors: 1, usbTroubles: 3, readErrors: 2, damaged: 1 })).toBe('1 disk error in Windows · 3 USB pauses · 2 files not readable · 1 damaged copy');
  });
});

describe('the headline of "What would I lose?"', () => {
  it('Nothing would be lost, in green, when every file has a checked copy', () => {
    expect(loseHeadline('T7', detail([0, 0], [0, 0], 500))).toMatchObject({ tone: 'ok', title: 'Nothing would be lost' });
  });

  it('says how much and how many are safe; red when sure, amber when only maybes', () => {
    expect(loseHeadline('T7', detail([10, 5_000_000_000], [5, 1_000_000_000], 100))).toEqual({
      tone: 'crit',
      title: '6 GB (15 files) would be lost',
      sub: 'If T7 died today, these have no other checked copy. 85 of 100 files are safe.',
    });
    expect(loseHeadline('T7', detail([0, 0], [1, 1_000], 100)).tone).toBe('amber');
  });

  it('a place with no known files says so instead of "nothing would be lost"', () => {
    expect(loseHeadline('T7', detail([0, 0], [0, 0], 0)).title).toBe('Backup Hub knows of no files on T7 yet');
  });

  it('kinds in plain words, anything unknown as "Everything else"', () => {
    expect(kindLabel('photo-camera')).toBe('Camera photos');
    expect(kindLabel('zzz')).toBe('Everything else');
  });
});

describe('the chooser and the Home card', () => {
  const places = [place({ id: 'g1', kind: 'gdrive', label: 'b@x.com' }), place({ id: 'p', kind: 'phone', label: 'Poco' }), place({ id: 's', label: 'Seagate' }), place({ id: 't7', label: 'T7' }), place({ id: 'l', kind: 'laptop', label: 'This laptop' })];

  it('lists drives first, then the laptop, phones and accounts', () => {
    expect(loseChoices(places).map((c) => c.label)).toEqual(['Seagate', 'T7', 'This laptop', 'Poco', 'b@x.com']);
  });

  it('shows only named drives that have files without a second copy, the biggest first; nothing while counting', () => {
    expect(homeLoseItems(places, null)).toEqual([]);
    expect(homeLoseItems(places, [])).toEqual([]);
    const items = homeLoseItems(places, [
      { placeId: 's', files: 0, bytes: 0 },
      { placeId: 't7', files: 3_450, bytes: 12_000_000_000 },
      { placeId: 'l', files: 5, bytes: 50 },
      { placeId: 'gone', files: 9, bytes: 9 },
    ]);
    expect(items).toEqual([{ placeId: 't7', label: 'T7', text: '3,450 files · 12 GB' }]);
  });
});
