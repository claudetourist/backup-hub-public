import { describe, expect, it } from 'vitest';
import type { PlaceView, UnnamedDriveView } from '../../shared/places';
import { accountCheckedText, checkedWhen, cloudOnlyText, connectedDrivesSummary, filesText, lastLookedText, listingStateText, listNowBlockedReason, seenConnectedText, placeStatus, quotaFraction, quotaText, spaceText, unnamedDriveDetail, usedFraction } from './placesModel';

const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();

describe('placesModel', () => {
  it('words statuses plainly', () => {
    expect(placeStatus('connected', 'drive')).toEqual({ tone: 'ok', label: 'Connected' });
    expect(placeStatus('connected', 'laptop').label).toBe('This laptop');
    expect(placeStatus('disconnected', 'drive')).toEqual({ tone: 'neutral', label: 'Not plugged in' });
    expect(placeStatus('disconnected', 'onedrive')).toEqual({ tone: 'neutral', label: 'Not connected' });
    expect(placeStatus('unknown', 'drive').label).toBe('Checking');
  });

  it('words Google account statuses and quota', () => {
    expect(placeStatus('needs_signin', 'gdrive')).toEqual({ tone: 'amber', label: 'Needs sign-in' });
    expect(placeStatus('problem', 'drive')).toEqual({ tone: 'amber', label: 'Plugged in, but not readable' });
    expect(seenConnectedText({ status: 'problem', lastConnectedAt: null, kind: 'drive' }, 0)).toBe('Now');
    expect(listNowBlockedReason({ kind: 'drive', status: 'problem', listing: 'idle' })).toBe("Windows can't read it properly right now");
    expect(placeStatus('unknown', 'gdrive').label).toBe('Not checked yet');
    expect(quotaText(4.2e9, 15e9)).toBe('4.2 GB of 15 GB used');
    expect(quotaText(4.2e9, null)).toBe('4.2 GB used');
    expect(quotaText(null, 15e9)).toBe('');
    expect(quotaFraction(5, 10)).toBe(0.5);
    expect(quotaFraction(20, 10)).toBe(1);
    expect(quotaFraction(5, null)).toBeNull();
    expect(quotaFraction(5, 0)).toBeNull();
  });

  it('formats free and total space', () => {
    expect(spaceText(322e9, 1e12)).toBe('322 GB free of 1 TB');
    expect(spaceText(null, 1e12)).toBe('1 TB in total');
    expect(spaceText(5, null)).toBe('');
    expect(usedFraction(250, 1000)).toBeCloseTo(0.75);
    expect(usedFraction(null, 1000)).toBeNull();
    expect(usedFraction(10, 0)).toBeNull();
  });

  it('shows last looked amber only after 7 days or never', () => {
    expect(lastLookedText(null, NOW)).toEqual({ text: 'Never', tone: 'amber' });
    expect(lastLookedText(NOW - 5 * 60_000, NOW)).toEqual({ text: '11:55', tone: 'neutral' });
    expect(lastLookedText(NOW - 2 * 24 * 3600_000, NOW).tone).toBe('neutral');
    expect(lastLookedText(NOW - 7 * 24 * 3600_000, NOW).tone).toBe('neutral');
    expect(lastLookedText(NOW - 7 * 24 * 3600_000 - 1000, NOW).tone).toBe('amber');
  });

  it('says when a place was checked in few words', () => {
    expect(checkedWhen(NOW - 3 * 3600_000, NOW)).toBe('today 09:00');
    expect(checkedWhen(NOW - 24 * 3600_000, NOW)).toBe('yesterday');
    expect(checkedWhen(new Date(2026, 10, 9, 8, 0).getTime(), new Date(2026, 10, 24).getTime())).toBe('9 Nov');
    expect(checkedWhen(new Date(2025, 10, 9, 8, 0).getTime(), NOW)).toBe('9 Nov 2025');
    expect(accountCheckedText(null, NOW)).toBe('Not checked yet');
    expect(accountCheckedText(new Date(2026, 9, 22, 8, 0).getTime(), NOW)).toBe('Checked 22 Oct');
  });

  it('keeps "seen connected" separate from "last looked"', () => {
    const drive = { kind: 'drive' as const, status: 'disconnected' as const, lastConnectedAt: null };
    expect(seenConnectedText({ ...drive, status: 'connected' }, NOW)).toBe('Now');
    expect(seenConnectedText(drive, NOW)).toBe('Never');
    expect(seenConnectedText({ ...drive, lastConnectedAt: NOW - 5 * 60_000 }, NOW)).toBe('11:55');
    expect(seenConnectedText({ kind: 'gdrive', status: 'unknown', lastConnectedAt: null }, NOW)).toBe('');
    // A phone: last seen is when the app last read it.
    expect(seenConnectedText({ kind: 'phone', status: 'disconnected', lastConnectedAt: null, lastLookedAt: NOW - 5 * 60_000 }, NOW)).toBe('11:55');
    // a plugged-in phone (main matched its serial) is Connected, Last seen Now
    expect(seenConnectedText({ kind: 'phone', status: 'connected', lastConnectedAt: null, lastLookedAt: NOW - 5 * 60_000 }, NOW)).toBe('Now');
    expect(placeStatus('connected', 'phone')).toEqual({ tone: 'ok', label: 'Connected' });
    expect(seenConnectedText({ kind: 'phone', status: 'disconnected', lastConnectedAt: null, lastLookedAt: null }, NOW)).toBe('');
  });

  it('words the file counts, cloud-only line and listing state', () => {
    expect(filesText({ files: null, lastLookedAt: null })).toBe('Not listed yet');
    expect(filesText({ files: { files: 0, totalBytes: 0, cloudOnly: 0 }, lastLookedAt: 5 })).toBe('0 files');
    expect(filesText({ files: { files: 12345, totalBytes: 4.2e9, cloudOnly: 0 }, lastLookedAt: 5 })).toBe('12,345 files · 4.2 GB');
    expect(filesText({ files: { files: 1, totalBytes: 2000, cloudOnly: 0 }, lastLookedAt: 5 })).toBe('1 file · 2 KB');
    expect(cloudOnlyText({ files: { files: 10, totalBytes: 1, cloudOnly: 1200 } })).toBe('1,200 only in the cloud');
    expect(cloudOnlyText({ files: { files: 10, totalBytes: 1, cloudOnly: 0 } })).toBe('');
    expect(listingStateText('running')).toBe('Checking now');
    expect(listingStateText('queued')).toBe('Waiting to check');
    expect(listingStateText('idle')).toBe('');
  });

  it('says why Check everything is not offered', () => {
    expect(listNowBlockedReason({ kind: 'drive', status: 'connected', listing: 'idle' })).toBe('');
    expect(listNowBlockedReason({ kind: 'drive', status: 'disconnected', listing: 'idle' })).toBe('Not connected');
    expect(listNowBlockedReason({ kind: 'laptop', status: 'connected', listing: 'running' })).toBe('Checking now');
    expect(listNowBlockedReason({ kind: 'gdrive', status: 'unknown', listing: 'idle' })).toBe('');
  });

  it('describes unnamed drives', () => {
    const drive: UnnamedDriveView = {
      letter: 'E:',
      label: '',
      fileSystem: 'exFAT',
      capacityBytes: 1e12,
      freeBytes: 322e9,
      driveType: 'removable',
      canName: true,
      reason: null,
      probable: null,
    };
    expect(unnamedDriveDetail(drive)).toBe('Removable drive · exFAT · 322 GB free of 1 TB');
    expect(unnamedDriveDetail({ ...drive, driveType: 'fixed' })).toContain('may be inside this laptop');
  });

  it('summarises connected named drives', () => {
    const place = (label: string, status: PlaceView['status'], kind: PlaceView['kind'] = 'drive'): PlaceView => ({
      id: label,
      kind,
      label,
      profileId: 1,
      profileName: 'You',
      status,
      rootHint: null,
      capacityBytes: null,
      freeBytes: null,
      lastLookedAt: null,
      lastConnectedAt: null,
      files: null,
      listing: 'idle',
      listingDetail: null,
      listJob: null,
      canList: false,
      problem: null,
      fingerprint: null,
      canFingerprint: false,
      roots: null,
      thisDevice: false,
      gdrive: null,
      laptopVolumes: null,
    });
    expect(connectedDrivesSummary([place('SAM', 'connected', 'laptop'), place('T7', 'disconnected')])).toBe('No named drive is connected');
    expect(connectedDrivesSummary([place('T7', 'connected'), place('Spare', 'connected')])).toBe('Connected: T7, Spare');
  });
});
