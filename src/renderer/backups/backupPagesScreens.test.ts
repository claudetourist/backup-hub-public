import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BackupRow } from '../../shared/backups';
import type { FolderBackupCards } from '../../shared/folderBackup';
import type { JobRecord } from '../../shared/jobs';
import type { MirrorStatusResult } from '../../shared/mirror';
import type { ConnectedPhones } from '../../shared/phoneBackup';
import type { ProfileView } from '../../shared/settings';
import { BackupPage } from './BackupPage';
import { buildEntries, filterEntries, sortEntries } from './backupListModel';
import { BackupsList } from './BackupsList';
import { OLD_TOOL_WARNING } from './phoneBackupModel';
import { FOLDER_OLD_TOOL_WARNING } from './folderBackupModel';
import type { BackupsData } from './useBackupsData';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const NOW = new Date(2026, 10, 25, 12).getTime();
const day = (d: number): number => NOW - d * 86_400_000;
const noop = (): void => undefined;

const two = [{ placeId: 't7', label: 'T7', position: 1, connected: true }, { placeId: 'sg', label: 'Seagate2TB', position: 2, connected: true }];
const row = (over: Partial<BackupRow> & { id: number; name: string }): BackupRow => ({ personId: 1, kind: 'folder', from: 'C:\\Users\\you\\OneDrive', driveLabel: 'T7', folder: 'MyData/OneDriveBackup', driveConnected: true, lastBackupAt: day(2), enabled: true, lastRunFailed: false, hubHasRun: false, phoneLinked: false, choices: 0, ...over });
const ROWS: BackupRow[] = [
  row({ id: 1, name: 'Poco F4', kind: 'phone', from: 'Phone', folder: 'MyData/POCO', lastBackupAt: day(40), phoneLinked: true, destinations: two, fromOldTool: true }),
  row({ id: 2, name: 'OneDrive Local Backup', from: 'C:\\Users\\you\\OneDrive', destinations: two }),
  row({ id: 3, name: 'DDrive Local Backup', from: 'D:\\MyData', folder: 'MyData/DDriveBackup', lastBackupAt: null }),
  row({ id: 4, name: 'Google Keep notes', from: 'C:\\Users\\you\\AppData\\keep-sync', folder: 'MyData/Keep' }),
];
/** The list with one backup changed. */
const patched = (id: number, patch: Partial<BackupRow>): BackupRow[] => ROWS.map((r) => (r.id === id ? Object.assign({}, r, patch) : r));
const profiles: ProfileView[] = [{ id: 1, name: 'You', color: '#0b6', createdAt: 1, placeCount: 1, backups: 4, phones: 1, accounts: 0, isFirst: true } as ProfileView];
const mirror: MirrorStatusResult = {
  backups: [1, 2].map((id) => ({ backupId: id, sourceLabel: 'T7', sourceConnected: true, mirrors: [{ placeId: 'sg', label: 'Seagate2TB', position: 2, connected: true, behindFiles: id === 1 ? 1234 : 0, behindBytes: 12_000_000_000, needYou: 0 }] })),
};
const connected: ConnectedPhones = { adb: 'ready', phones: [{ backupId: 1, backupName: 'Poco F4', phoneName: 'Poco F4', serial: 'S', driveConnected: true }], hint: null, newPhones: [], backupsWithoutPhone: [] };
const cards: FolderBackupCards = { cards: [{ backupId: 2, backupName: 'OneDrive Local Backup', sourceWords: 'C:\\Users\\you\\OneDrive', driveLabel: 'T7', driveConnected: true, layout: 'dated' }], keepSync: { available: false, exists: false } };
const job = (over: Partial<JobRecord> & { id: number; kind: string }): JobRecord => ({ title: 'x', state: 'running', progressDone: 0, progressTotal: 0, bytesDone: 0, bytesTotal: 0, message: null, warnings: [], error: null, createdAt: 1, startedAt: 1, finishedAt: null, hasCheckpoint: false, speed: null, etaSeconds: null, paused: false, choices: [], ...over });

const data = (over: Partial<BackupsData> = {}): BackupsData => ({
  now: NOW,
  overview: { backups: ROWS, historyBroughtInAt: day(5) },
  loadError: null,
  rows: ROWS,
  removed: [],
  folderCards: cards,
  connected,
  lookingForPhones: false,
  hiddenPhones: new Set(),
  hidePhone: noop,
  mirror,
  sizes: new Map([[1, { backupId: 1, files: 18_204, bytes: 96_400_000_000 }]]),
  jobs: [],
  profiles,
  scope: 'all',
  load: noop,
  checkPhones: noop,
  ...over,
});

describe('the list page', () => {
  it('has one row for every kind: phone, OneDrive, D drive and notes, each with name, source, drives, status word, last date and size', () => {
    const html = render(h(BackupsList, { data: data(), onOpen: noop }));
    for (const name of ['Poco F4', 'OneDrive Local Backup', 'DDrive Local Backup', 'Google Keep notes']) expect(html).toContain('>' + name + '</button>');
    expect(html.match(/class="bk-row /g)).toHaveLength(4);
    expect(html).toContain('T7 + Seagate2TB · MyData/POCO');
    expect(html).toContain('18,204 files · 96.4 GB');
    // The size of the others is not known yet: a placeholder or "Not counted", never a gap.
    expect(html).toContain('Not counted');
    expect(html).toContain('Behind');
    expect(html).toContain('Never backed up');
    expect(html).toContain('Up to date');
    expect(html).toContain('Find a backup');
    expect(html).toContain('Sort by');
  });

  it('shows the placeholder while the sizes are being counted, and a live line when a job of the backup runs (also a job over all backups)', () => {
    const running = job({ id: 9, kind: 'mirror.copy', bytesDone: 17, bytesTotal: 100, backupIds: [1, 2] });
    const html = render(h(BackupsList, { data: data({ sizes: 'loading', jobs: [running] }), onOpen: noop }));
    expect(html).toContain('Counting…');
    expect(html.match(/Copying to Seagate2TB, 17%/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('has the page-level actions in the header, worded with the drive name', () => {
    const html = render(h(BackupsList, { data: data(), onOpen: noop }));
    expect(html).toContain('Bring Seagate2TB up to date (all backups)');
    expect(html).toContain('Check old copies on Seagate2TB (all backups)');
  });

  it('has no panel of its own: nothing about phones in a list of folders, no second copy panel floating around', () => {
    const folders = ROWS.filter((r) => r.kind === 'folder');
    const html = render(h(BackupsList, { data: data({ rows: folders, connected: null, overview: { backups: folders, historyBroughtInAt: day(5) } }), onOpen: noop }));
    expect(html).not.toContain(OLD_TOOL_WARNING);
    expect(html).not.toContain('Check old copies</h2>');
    expect(html).not.toContain('Second copy</h2>');
    expect(html).not.toContain('Change phone');
  });

  it('says plainly when there are no backups for this person, and offers the removed ones back', () => {
    const none = render(h(BackupsList, { data: data({ rows: [] }), onOpen: noop }));
    expect(none).toContain('has no backups yet');
    const withRemoved = render(h(BackupsList, { data: data({ removed: [{ id: 9, name: 'OneDrive IMP Folder', personId: 1, from: 'C:\\x', removedAt: 1 }] }), onOpen: noop }));
    expect(withRemoved).toContain('Show removed backups (1)');
  });

  it('500 backups: every one is a row, and building, searching and sorting them is a fraction of a second of plain code (the rows are memoised, with no data fetching or panel inside)', () => {
    const many = Array.from({ length: 500 }, (_, i) => row({ id: 100 + i, name: 'Backup ' + i, lastBackupAt: i % 7 === 0 ? null : day(i % 50) }));
    let t = performance.now();
    const entries = buildEntries(many, { now: NOW, mirror: null, sizes: 'loading', jobs: Array.from({ length: 300 }, (_, i) => job({ id: i + 1, kind: 'phone.backup', backupIds: [100 + (i % 500)] })), connected: null, ownerNames: new Map([[1, 'You']]) });
    const shown = sortEntries(filterEntries(entries, 'backup 4'), 'status');
    sortEntries(entries, 'name');
    sortEntries(entries, 'last');
    const modelMs = performance.now() - t;
    expect(shown.length).toBeGreaterThan(0);
    expect(modelMs).toBeLessThan(250);
    t = performance.now();
    const html = render(h(BackupsList, { data: data({ rows: many, overview: { backups: many, historyBroughtInAt: null }, mirror: null, connected: null }), onOpen: noop }));
    // The page build of React in the test is the slow development one; this is only for the record.
    console.log('model of 500 backups', Math.round(modelMs), 'ms; markup', Math.round(performance.now() - t), 'ms (development React)');
    expect(html.match(/class="bk-row /g)).toHaveLength(500);
  }, 60_000);
});

describe("a backup's page", () => {
  const page = (id: number, over: Partial<BackupsData> = {}, tab: 'overview' | 'backup' | 'second' | 'check' | 'history' = 'overview'): string => render(h(BackupPage, { data: data(over), address: { id, tab, go: false }, onBack: noop }));

  it('has a Back button, the title "Backups > name", the header and only the sections that apply', () => {
    const html = page(2);
    expect(html).toContain('Back');
    expect(html).toContain('Backups &gt; OneDrive Local Backup');
    expect(html).toContain('role="tablist"');
    for (const label of ['Overview', 'Back up now', 'Second copy', 'Check old copies', 'Exclusions', 'History']) expect(html).toContain('>' + label);
    expect(html).not.toContain('>Not covered');
    expect(html).toContain('C:\\Users\\you\\OneDrive');
    expect(html).toContain('T7 + Seagate2TB');
  });

  it('shows the running job of this backup, with Pause and Stop', () => {
    const html = page(2, { jobs: [job({ id: 9, kind: 'mirror.copy', bytesDone: 50, bytesTotal: 100, backupIds: [1, 2] })] });
    expect(html).toContain('Copying to Seagate2TB, 50%');
    expect(html).toContain('>Pause<');
    expect(html).toContain('>Stop<');
    expect(page(3)).not.toContain('>Stop<');
  });

  it('the second copy section is about THIS backup only: the other backup is not named, and the panel has no title of its own', () => {
    const html = page(1, {}, 'second');
    expect(html).toContain('Bring Seagate2TB up to date');
    expect(html).toContain('1,234 files');
    expect(html).not.toContain('OneDrive Local Backup');
    expect(html).not.toContain('>Second copy</h2>');
  });

  it('a folder backup page has no phone words: no old-tool phone warning, no Change phone, no Not covered, no "plug in the phone"', () => {
    const html = [page(2), page(2, {}, 'backup'), page(2, {}, 'check'), page(2, {}, 'second')].join('\n');
    for (const word of [OLD_TOOL_WARNING, 'Change phone', 'Not covered', 'Check for a phone', 'Plug it in', 'cable', 'unlock']) expect(html).not.toContain(word);
    // It came from the old tool: its own words, for a folder.
    expect(page(2, { rows: patched(2, { fromOldTool: true }) })).toContain(FOLDER_OLD_TOOL_WARNING);
    // A backup made by Backup Hub itself carries no old-tool words at all.
    expect(page(3)).not.toContain('PhoneBackup');
  });

  it('a phone backup page has its phone words, and the old-tool warning only because it came from the old tool', () => {
    expect(page(1)).toContain(OLD_TOOL_WARNING);
    expect(page(1)).toContain('Change phone');
    expect(page(1, { rows: patched(1, { fromOldTool: false }) })).not.toContain(OLD_TOOL_WARNING);
    expect(page(1, {}, 'backup')).toContain('Back up Poco F4 now');
    expect(page(1, { connected: { ...connected, phones: [] } }, 'backup')).toContain('is not plugged in');
  });

  it('says so, with a way back, when the backup is not on the list', () => {
    const html = page(99);
    expect(html).toContain('This backup is not on the list');
    expect(html).toContain('Back');
  });

  it('a switched-off backup offers "Remove from list" and no status', () => {
    const html = page(3, { rows: patched(3, { enabled: false }) });
    expect(html).toContain('Remove from list');
    expect(html).toContain('Switched off');
    expect(page(2)).not.toContain('Remove from list');
  });
});
