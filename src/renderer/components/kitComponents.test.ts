import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BACKUP_STATUSES, STATUS_WORDS } from './backupStatus';
import { DataTable, type Column } from './DataTable';
import { DeviceDot } from './DeviceDot';
import { Drawer } from './Drawer';
import { KindChip } from './KindChip';
import { KIND_CHIPS } from './kindChips';
import { PopupMenu } from './PopupMenu';
import { PreviewList } from './PreviewList';
import { ProgressPanel } from './ProgressPanel';
import { Rail } from './Rail';
import { Report } from './Report';
import { Skeleton } from './Skeleton';
import { StateView } from './StateView';
import { StatusPill } from './StatusPill';
import { ToastStack } from './Toast';
import { makeToast } from './toastModel';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('StatusPill', () => {
  it.each(BACKUP_STATUSES)('%s shows its word and an icon, never colour alone', (status) => {
    const html = render(h(StatusPill, { status }));
    expect(html).toContain(STATUS_WORDS[status]);
    expect(html).toContain('<svg');
    expect(html).toContain(`data-status="${status}"`);
  });
  it('draws only "Not connected" with a dashed outline', () => {
    expect(render(h(StatusPill, { status: 'not-connected' }))).toContain('status-pill--dashed');
    for (const status of BACKUP_STATUSES.filter((s) => s !== 'not-connected')) expect(render(h(StatusPill, { status }))).not.toContain('status-pill--dashed');
  });
  it('shows the numbers and how old the information is', () => {
    const html = render(h(StatusPill, { status: 'behind', files: 312, bytes: 4_200_000_000, updated: '2 hours ago' }));
    expect(html).toContain('by 312 files (4.2 GB)');
    expect(html).toContain('updated 2 hours ago');
  });
});

describe('KindChip', () => {
  it('has a colour class, an icon and the word for each of the nine kinds', () => {
    for (const kind of KIND_CHIPS) {
      const html = render(h(KindChip, { id: kind.id }));
      expect(html).toContain(`kind-chip--${kind.id}`);
      expect(html).toContain('<svg');
      expect(html).toContain(kind.label);
    }
  });
});

describe('DeviceDot', () => {
  it('shows the name beside a decorative dot', () => {
    const html = render(h(DeviceDot, { name: 'Seagate2TB', color: '#2563eb' }));
    expect(html).toContain('Seagate2TB');
    expect(html).toContain('aria-hidden="true"');
  });
  it('with only a dot, a screen reader still hears the device', () => {
    expect(render(h(DeviceDot, { name: 'T7', label: 'The T7 drive' }))).toContain('<span class="sr-only">The T7 drive</span>');
  });
});

describe('Skeleton', () => {
  it('says what it is doing and is announced as busy', () => {
    const html = render(h(Skeleton, { what: 'Reading the phone', rows: 3 }));
    expect(html).toContain('Reading the phone');
    expect(html).toContain('aria-busy="true"');
    expect(count(html, 'skeleton__bar')).toBe(3);
  });
});

describe('StateView: loading, empty, error, loaded', () => {
  const base = { loadingText: 'Reading the phone', emptyTitle: 'No files yet', emptyText: 'Plug in the phone.', onRetry: noop };
  it('loading shows the skeleton with what it is doing', () => {
    const html = render(h(StateView, { ...base, loading: true, error: null, count: null, children: 'RESULTS' }));
    expect(html).toContain('Reading the phone');
    expect(html).not.toContain('RESULTS');
  });
  it('empty shows one sentence', () => {
    const html = render(h(StateView, { ...base, loading: false, error: null, count: 0, children: 'RESULTS' }));
    expect(html).toContain('No files yet');
    expect(html).toContain('Plug in the phone.');
    expect(html).not.toContain('RESULTS');
  });
  it('error says it in plain words and offers Retry', () => {
    const html = render(h(StateView, { ...base, loading: false, error: 'The phone stopped answering.', count: null, children: 'RESULTS' }));
    expect(html).toContain('The phone stopped answering.');
    expect(html).toContain('>Retry<');
    expect(html).toContain('role="alert"');
  });
  it('loaded shows the results, not dimmed', () => {
    const html = render(h(StateView, { ...base, loading: false, error: null, count: 3, children: 'RESULTS' }));
    expect(html).toContain('RESULTS');
    expect(html).not.toContain('is-dimmed');
  });
  it('old results stay on screen, dimmed, while new ones load', () => {
    const html = render(h(StateView, { ...base, loading: true, error: null, count: 3, children: 'RESULTS' }));
    expect(html).toContain('RESULTS');
    expect(html).toContain('is-dimmed');
    expect(html).toContain('aria-busy="true"');
  });
});

describe('Toast', () => {
  it('shows each message with a close button; an error is an alert', () => {
    const html = render(h(ToastStack, { toasts: [makeToast(1, { text: 'Looking' }), makeToast(2, { tone: 'error', text: 'Failed' })], onDismiss: noop }));
    expect(html).toContain('Looking');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(count(html, 'aria-label="Close this message"')).toBe(2);
  });
});

interface Row {
  id: string;
  name: string;
  size: number;
}
const COLUMNS: readonly Column<Row>[] = [
  { key: 'name', header: 'Name', rowHeader: true, sortValue: (r) => r.name, render: (r) => r.name },
  { key: 'size', header: 'Size', align: 'end', sortValue: (r) => r.size, render: (r) => String(r.size) },
];
const rows = (n: number): Row[] => Array.from({ length: n }, (_unused, i) => ({ id: String(i), name: `file-${i}`, size: i }));

describe('DataTable (long-table mode)', () => {
  it('draws only the rows in view out of 100,000, with the right size for a screen reader', () => {
    const html = render(h(DataTable<Row>, { caption: 'Big', columns: COLUMNS, rows: rows(100_000), rowKey: (r) => r.id, virtual: { height: 400, rowHeight: 40 } }));
    expect(count(html, 'aria-rowindex=')).toBeLessThan(30);
    expect(html).toContain('aria-rowcount="100001"');
    expect(html).toContain('file-0');
    expect(html).not.toContain('file-5000<');
  });
  it('is one tab stop with arrow-key navigation, a sticky header and sortable headers', () => {
    const html = render(h(DataTable<Row>, { caption: 'Big', columns: COLUMNS, rows: rows(50), rowKey: (r) => r.id, virtual: {} }));
    expect(html).toContain('role="grid"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-table--sticky');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain('<caption class="sr-only">Big</caption>');
  });
  it('says so when there are no rows', () => {
    const html = render(h(DataTable<Row>, { caption: 'Empty', columns: COLUMNS, rows: [], rowKey: (r) => r.id, virtual: {}, emptyText: 'No files.' }));
    expect(html).toContain('No files.');
  });
  it('the normal mode is unchanged: a "Show more" window, no grid role', () => {
    const html = render(h(DataTable<Row>, { caption: 'Normal', columns: COLUMNS, rows: rows(1000), rowKey: (r) => r.id, windowRows: 100 }));
    expect(html).toContain('Showing 100 of 1,000.');
    expect(html).not.toContain('role="grid"');
  });
});

describe('Drawer', () => {
  it('is a labelled dialog that blocks the page behind it, with a close button', () => {
    const html = render(h(Drawer, { title: 'Poco F4 camera', subtitle: 'A backup', onClose: noop, footer: h('button', { type: 'button' }, 'Save'), children: h('p', null, 'Body') }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('Poco F4 camera');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('Body');
    expect(html).toContain('Save');
  });
});

describe('PreviewList', () => {
  const items = [
    { id: 'small', name: 'small.txt', bytes: 10 },
    { id: 'big', name: 'big.mp4', bytes: 9_000_000_000, kind: 'video-camera' },
    { id: 'mid', name: 'mid.jpg', bytes: 4_000_000, kind: 'photo-camera' },
  ];
  const props = { caption: 'Files to copy', items, onUntickedChange: noop, confirmLabel: ({ files }: { files: number }) => `Copy ${files} files to Seagate`, onConfirm: noop };
  it('lists the largest first, with how many are ticked and the one button', () => {
    const html = render(h(PreviewList, { ...props, unticked: new Set<string>() }));
    expect(html.indexOf('big.mp4')).toBeLessThan(html.indexOf('mid.jpg'));
    expect(html.indexOf('mid.jpg')).toBeLessThan(html.indexOf('small.txt'));
    expect(html).toContain('3 of 3 files ticked, 9 GB');
    expect(html).toContain('Copy 3 files to Seagate');
  });
  it('counts only what is still ticked, and turns the button off when nothing is', () => {
    const some = render(h(PreviewList, { ...props, unticked: new Set(['big']) }));
    expect(some).toContain('2 of 3 files ticked');
    expect(some).toContain('Copy 2 files to Seagate');
    const none = render(h(PreviewList, { ...props, unticked: new Set(['big', 'mid', 'small']) }));
    expect(none).toContain('0 of 3 files ticked');
    expect(none).toMatch(/<button[^>]*disabled[^>]*>Copy 0 files to Seagate/);
  });
  it('says how many files were skipped and why', () => {
    const html = render(h(PreviewList, { ...props, unticked: new Set<string>(), skipped: { count: 12, reasons: [{ reason: 'already on the Seagate', count: 12 }] } }));
    expect(html).toContain('Skipped: 12 files');
    expect(html).toContain('12 already on the Seagate');
  });
  it('shows no skipped line when nothing was skipped', () => {
    expect(render(h(PreviewList, { ...props, unticked: new Set<string>() }))).not.toContain('Skipped');
  });
});

describe('ProgressPanel', () => {
  const props = { what: 'Copying Poco F4 camera to Seagate', doneBytes: 5_000_000_000, totalBytes: 10_000_000_000, bytesPerSecond: 50_000_000, onPause: noop, onResume: noop, onStop: noop };
  it('shows what, how much, speed, time left, Pause and Stop', () => {
    const html = render(h(ProgressPanel, props));
    expect(html).toContain('Copying Poco F4 camera to Seagate');
    expect(html).toContain('5 GB of 10 GB');
    expect(html).toContain('50 MB/s');
    expect(html).toContain('about 2 minutes left');
    expect(html).toContain('>Pause<');
    expect(html).toContain('>Stop<');
    expect(html).toContain('role="progressbar"');
  });
  it('when paused offers Resume and says it is safe to close the app', () => {
    const html = render(h(ProgressPanel, { ...props, paused: true }));
    expect(html).toContain('>Resume<');
    expect(html).toContain('Paused — safe to close the app');
    expect(html).not.toContain('Pausing');
  });
  it('while the job still finishes its file it says Pausing and does not say it is safe to close', () => {
    const html = render(h(ProgressPanel, { ...props, paused: true, pausing: true }));
    expect(html).toContain('Pausing: saving your place…');
    expect(html).not.toContain('safe to close');
  });
  it('with no totals it shows that it is working', () => {
    expect(render(h(ProgressPanel, { what: 'Reading the phone', onPause: noop, onResume: noop, onStop: noop }))).toContain('progress--indeterminate');
  });
});

describe('Report', () => {
  const data = {
    copied: { files: 312, bytes: 4_200_000_000 },
    skipped: [{ reason: 'already on the Seagate', count: 8 }],
    failed: [{ reason: 'the phone stopped answering', count: 2, examples: ['IMG_1.jpg'] }],
    where: ['Seagate2TB, folder Poco F4/2026-11-22'],
    finished: '22 Nov, 14:05',
  };
  it('shows copied, skipped and why, failed and why, and where it went', () => {
    const html = render(h(Report, { data }));
    expect(html).toContain('Copied 312 files (4.2 GB), 2 failed');
    expect(html).toContain('already on the Seagate');
    expect(html).toContain('the phone stopped answering');
    expect(html).toContain('IMG_1.jpg');
    expect(html).toContain('Where it went');
    expect(html).toContain('Seagate2TB, folder Poco F4/2026-11-22');
    expect(html).toContain('report--warn');
  });
  it('says plainly when nothing was skipped or failed', () => {
    const html = render(h(Report, { data: { ...data, skipped: [], failed: [] } }));
    expect(html).toContain('Nothing was skipped.');
    expect(html).toContain('Nothing failed.');
    expect(html).toContain('report--ok');
  });
});

describe('PopupMenu', () => {
  it('is a closed button that says it opens a menu', () => {
    const html = render(h(PopupMenu, { label: 'Person', trigger: 'You', items: [{ id: 'you', label: 'You', checked: true, onSelect: noop }] }));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });
});

describe('Rail (the sidebar)', () => {
  it('shows a person switcher with only "You", then the screens that exist, then the menu', () => {
    const html = render(h(Rail, { route: { screen: 'files', sub: null }, onSelect: noop }));
    expect(html).toContain('aria-label="Person"');
    const labels = ['Home', 'Backups', 'Devices', 'Files', 'Free up space', 'Activity'];
    const at = labels.map((label) => html.indexOf(`<span>${label}</span>`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at.toSorted((a, b) => a - b)).toEqual(at);
    expect(html).toContain('aria-label="Settings and more"');
  });
  it('marks the screen you are on, and every entry is a link (reachable by keyboard)', () => {
    const html = render(h(Rail, { route: { screen: 'devices', sub: null }, onSelect: noop }));
    expect(count(html, 'aria-current="page"')).toBe(1);
    expect(html).toMatch(/<a href="#\/devices" class="rail__item" aria-current="page">/);
    for (const id of ['home', 'devices', 'files', 'free-up-space', 'activity']) expect(html).toContain(`href="#/${id}"`);
  });
});
