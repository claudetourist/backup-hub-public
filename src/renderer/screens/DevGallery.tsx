import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AttentionList, AttentionRow } from '../components/AttentionRow';
import { Button, type ButtonSize, type ButtonVariant } from '../components/Button';
import { CoverageBar, CoverageLegend } from '../components/CoverageBar';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { ProgressBar } from '../components/ProgressBar';
import { CopyCountPill, JobStatePill, Pill, StatusPill } from '../components/StatusPill';
import { BACKUP_STATUSES, type StatusInfo } from '../components/backupStatus';
import { DeviceDot } from '../components/DeviceDot';
import { Drawer } from '../components/Drawer';
import { KindChip } from '../components/KindChip';
import { KIND_CHIP_IDS } from '../components/kindChips';
import { PreviewList } from '../components/PreviewList';
import type { PreviewItem } from '../components/previewModel';
import { ProgressPanel } from '../components/ProgressPanel';
import { Rail } from '../components/Rail';
import { Report } from '../components/Report';
import { Skeleton } from '../components/Skeleton';
import { StateView } from '../components/StateView';
import { ToastStack, useToast } from '../components/Toast';
import { makeToast } from '../components/toastModel';
import { DEVICE_COLORS } from '../components/deviceColors';
import { StatTile } from '../components/StatTile';
import { JOB_STATES, TONES } from '../components/status';
import { SearchIcon } from '../icons';
import { useRoute } from '../navContext';

/** Dev-only review page (Ctrl+Shift+G, or #gallery in the URL). Not shipped in production builds. */

interface DemoRow {
  id: string;
  name: string;
  files: number;
  bytes: number;
  note: string | null;
}

const DEMO_ROWS: DemoRow[] = [
  { id: 'a', name: 'Reunion', files: 1240, bytes: 46_500_000_000, note: 'Irreplaceable' },
  { id: 'b', name: 'Poco F4 camera', files: 9021, bytes: 51_000_000_000, note: null },
  { id: 'c', name: 'Rest of MyData', files: 33210, bytes: 28_800_000_000, note: 'Important' },
];

const DEMO_COLUMNS: readonly Column<DemoRow>[] = [
  { key: 'name', header: 'Name', rowHeader: true, sortValue: (r) => r.name, render: (r) => <b>{r.name}</b> },
  { key: 'files', header: 'Files', align: 'end', sortValue: (r) => r.files, render: (r) => <span className="mono">{r.files}</span> },
  { key: 'bytes', header: 'Bytes', align: 'end', sortValue: (r) => r.bytes, render: (r) => <span className="mono">{r.bytes}</span> },
  { key: 'note', header: 'Note (blank sorts last)', sortValue: (r) => r.note, render: (r) => r.note ?? '' },
];

/** The same piece in the light theme and in the dark theme, side by side. */
function BothThemes({ children }: { children: () => ReactNode }) {
  return (
    <div className="gallery-pair">
      {(['light', 'dark'] as const).map((theme) => (
        <div key={theme} className="theme-scope" data-theme={theme}>
          <p className="cell-sub">{theme === 'light' ? 'Light' : 'Dark'}</p>
          {children()}
        </div>
      ))}
    </div>
  );
}

const STATUS_SAMPLES: readonly StatusInfo[] = [
  { status: 'up-to-date', updated: '2 hours ago' },
  { status: 'behind', files: 312, bytes: 4_200_000_000, updated: '5 minutes ago' },
  { status: 'never' },
  { status: 'not-connected', lastKnown: 'up-to-date', lastSeen: '3 Nov', updated: '19 days ago' },
  { status: 'problem', problems: 3, updated: 'just now' },
];

interface BigRow {
  id: string;
  name: string;
  bytes: number;
  folder: string;
}

const KINDS_FOR_ROWS = ['photo-camera', 'video-camera', 'photo-screenshot', 'photo-whatsapp', 'audio-recording', 'audio-music', 'documents', 'archives', 'other'];

function makeBigRows(count: number): BigRow[] {
  return Array.from({ length: count }, (_unused, i) => ({
    id: String(i),
    name: `IMG_${String(i).padStart(6, '0')}.jpg`,
    bytes: ((i * 7919) % 9000) * 1000 + 40_000,
    folder: `DCIM/Camera/${2020 + (i % 7)}`,
  }));
}

const BIG_COLUMNS: readonly Column<BigRow>[] = [
  { key: 'name', header: 'Name', rowHeader: true, sortValue: (r) => r.name, render: (r) => r.name },
  { key: 'folder', header: 'Folder', sortValue: (r) => r.folder, render: (r) => r.folder },
  { key: 'bytes', header: 'Size', align: 'end', width: 120, sortValue: (r) => r.bytes, render: (r) => <span className="mono">{r.bytes}</span> },
];

function makePreviewItems(count: number): PreviewItem[] {
  return Array.from({ length: count }, (_unused, i) => ({
    id: String(i),
    name: `DCIM/Camera/IMG_${String(i).padStart(5, '0')}.jpg`,
    bytes: ((i * 7919) % 9000) * 1000 + 40_000,
    kind: KINDS_FOR_ROWS[i % KINDS_FOR_ROWS.length]!,
  }));
}

function KitPieces() {
  const toast = useToast();
  const bigRows = useMemo(() => makeBigRows(100_000), []);
  const previewItems = useMemo(() => makePreviewItems(2000), []);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [drawer, setDrawer] = useState(false);
  const [paused, setPaused] = useState(false);
  const [reloading, setReloading] = useState(false);
  const noop = (): void => undefined;
  return (
    <>
      <Panel title="Sidebar and person switcher">
        <BothThemes>
          {() => (
            <div className="app-frame">
              <Rail route={{ screen: 'devices', sub: null }} onSelect={noop} />
            </div>
          )}
        </BothThemes>
      </Panel>

      <Panel title="Status (exactly five: word, icon and colour)">
        <BothThemes>
          {() => (
            <div className="gallery-stack">
              {STATUS_SAMPLES.map((sample) => (
                <StatusPill key={sample.status} {...sample} />
              ))}
              {BACKUP_STATUSES.map((status) => (
                <StatusPill key={`bare-${status}`} status={status} />
              ))}
            </div>
          )}
        </BothThemes>
      </Panel>

      <Panel title="Kinds of file">
        <BothThemes>
          {() => (
            <div className="gallery-row">
              {KIND_CHIP_IDS.map((id) => (
                <KindChip key={id} id={id} />
              ))}
            </div>
          )}
        </BothThemes>
      </Panel>

      <Panel title="Device dots">
        <BothThemes>
          {() => (
            <div className="gallery-row">
              {DEVICE_COLORS.map((color, i) => (
                <DeviceDot key={color} name={`Device ${i + 1}`} color={color} />
              ))}
              <DeviceDot name="Seagate2TB" />
              <DeviceDot name="T7" />
              <DeviceDot name="Poco F4" />
            </div>
          )}
        </BothThemes>
      </Panel>

      <Panel title="The four states">
        <BothThemes>
          {() => (
            <div className="gallery-stack">
              <StateView loading error={null} count={null} loadingText="Reading the phone" emptyTitle="No files" emptyText="x" onRetry={noop}>
                x
              </StateView>
              <StateView loading={false} error={null} count={0} loadingText="x" emptyTitle="No files yet" emptyText="Plug in the phone and press Look at the phone." onRetry={noop}>
                x
              </StateView>
              <StateView loading={false} error="The phone stopped answering. Check the cable." count={null} loadingText="x" emptyTitle="x" emptyText="x" onRetry={noop}>
                x
              </StateView>
              <StateView loading={false} error={null} count={3} loadingText="x" emptyTitle="x" emptyText="x" onRetry={noop}>
                <p>3 results, shown normally.</p>
              </StateView>
              <StateView loading error={null} count={3} loadingText="x" emptyTitle="x" emptyText="x" onRetry={noop}>
                <p>3 old results, dimmed while new ones load.</p>
              </StateView>
            </div>
          )}
        </BothThemes>
        <div className="gallery-row">
          <Button variant="quiet" onClick={() => setReloading((v) => !v)} aria-pressed={reloading}>
            Toggle reloading
          </Button>
        </div>
        <StateView loading={reloading} error={null} count={2} loadingText="Reading the phone" emptyTitle="x" emptyText="x" onRetry={noop}>
          <p>Old results stay on screen, dimmed, while the new ones load.</p>
        </StateView>
        <Skeleton what="Looking at the Seagate" rows={3} />
      </Panel>

      <Panel title="Data table, 100,000 rows (virtual: scroll, sort, or Tab in and use the arrow keys, Page Up and Down, Home and End)" flush>
        <DataTable caption="100,000 rows" columns={BIG_COLUMNS} rows={bigRows} rowKey={(r) => r.id} virtual={{ height: 360 }} />
      </Panel>

      <Panel title="Preview before action (2,000 files, largest first)">
        <PreviewList
          caption="Files to copy to Seagate"
          items={previewItems}
          unticked={unticked}
          onUntickedChange={setUnticked}
          skipped={{
            count: 112,
            reasons: [
              { reason: 'already on the Seagate', count: 100 },
              { reason: 'name Windows cannot store', count: 12 },
            ],
          }}
          confirmLabel={({ files }) => `Copy ${files.toLocaleString('en-US')} files to Seagate`}
          onConfirm={() => toast.show({ tone: 'ok', text: 'This is a demo: nothing was copied.' })}
        />
      </Panel>

      <Panel title="Progress">
        <BothThemes>
          {() => (
            <ProgressPanel
              what="Copying Poco F4 camera to Seagate"
              doneBytes={17_200_000_000}
              totalBytes={46_500_000_000}
              doneFiles={5200}
              totalFiles={9021}
              bytesPerSecond={38_000_000}
              paused={paused}
              onPause={() => setPaused(true)}
              onResume={() => setPaused(false)}
              onStop={noop}
            />
          )}
        </BothThemes>
      </Panel>

      <Panel title="Report">
        <BothThemes>
          {() => (
            <Report
              data={{
                copied: { files: 8_900, bytes: 46_100_000_000 },
                skipped: [{ reason: 'already on the Seagate', count: 112 }],
                failed: [{ reason: 'the phone stopped answering', count: 9, examples: ['IMG_20240102_101010.jpg'] }],
                where: ['Seagate2TB, folder Poco F4/2026-11-22'],
                finished: '22 Nov, 14:05',
              }}
            />
          )}
        </BothThemes>
      </Panel>

      <Panel title="Messages and the side panel">
        <div className="gallery-row">
          <Button onClick={() => toast.show({ text: 'Looking at the phone.' })}>Show a message</Button>
          <Button onClick={() => toast.show({ tone: 'ok', text: 'Copied 312 files.' })}>Show a done message</Button>
          <Button onClick={() => toast.show({ tone: 'error', text: 'The Seagate is not plugged in.' })}>Show an error</Button>
          <Button onClick={() => setDrawer(true)}>Open the side panel</Button>
        </div>
        <BothThemes>{() => <ToastStackStatic />}</BothThemes>
        {drawer ? (
          <Drawer title="Poco F4 camera" subtitle="A backup" onClose={() => setDrawer(false)} footer={<Button variant="primary" onClick={() => setDrawer(false)}>Save</Button>}>
            <p>The same panel is used for details, add and edit. Tab stays inside; Esc closes it.</p>
            <input className="fsmall" aria-label="Name" defaultValue="Poco F4 camera" />
          </Drawer>
        ) : null}
      </Panel>
    </>
  );
}

function ToastStackStatic() {
  return <ToastStack inline toasts={[makeToast(1, { text: 'Looking at the phone.' }), makeToast(2, { tone: 'ok', text: 'Copied 312 files.' }), makeToast(3, { tone: 'error', text: 'The Seagate is not plugged in.' })]} onDismiss={() => undefined} />;
}

const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'quiet'];
const SIZES: readonly ButtonSize[] = ['sm', 'md', 'lg'];

function setTheme(theme: 'light' | 'dark' | null): void {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

export default function DevGallery() {
  const [empty, setEmpty] = useState(false);
  // "#/gallery/9" scrolls to the 10th panel (review screenshots of one part).
  const { sub } = useRoute();
  useEffect(() => {
    if (sub === null) return;
    document.querySelectorAll('.main > section.panel')[Number(sub)]?.scrollIntoView();
  }, [sub]);
  return (
    <>
      <PageHeader
        eyebrow="Developer only"
        title="Component gallery"
        subtitle="Every design-system component and state. Press Ctrl+Shift+G to leave."
        actions={
          <span className="gallery-row">
            <Button size="sm" onClick={() => setTheme('light')}>
              Light
            </Button>
            <Button size="sm" onClick={() => setTheme('dark')}>
              Dark
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setTheme(null)}>
              Follow system
            </Button>
          </span>
        }
      />

      <Panel title="Buttons">
        <div className="gallery-stack">
          {VARIANTS.map((variant) => (
            <div key={variant} className="gallery-row">
              {SIZES.map((size) => (
                <Button key={size} variant={variant} size={size}>
                  {variant} {size}
                </Button>
              ))}
              <Button variant={variant} icon={<SearchIcon size={16} />}>
                With icon
              </Button>
              <Button variant={variant} disabled>
                Disabled
              </Button>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Status pills">
        <div className="gallery-stack">
          <div className="gallery-row">
            {JOB_STATES.map((state) => (
              <JobStatePill key={state} state={state} />
            ))}
          </div>
          <div className="gallery-row">
            <CopyCountPill backups={0} />
            <CopyCountPill backups={1} />
            <CopyCountPill backups={2} />
            <CopyCountPill backups={5} />
          </div>
          <div className="gallery-row">
            {TONES.map((tone) => (
              <Pill key={tone} tone={tone}>
                {tone}
              </Pill>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Progress bars">
        <div className="gallery-stack gallery-stack--narrow">
          <ProgressBar label="Copying, 0 percent" value={0} />
          <ProgressBar label="Copying, 37 percent" value={37} valueText="17.2 of 46.5 GB" />
          <ProgressBar label="Verifying, 80 percent" value={80} tone="ok" />
          <ProgressBar label="Retrying, 100 percent" value={100} tone="warn" />
          <ProgressBar label="Looking at files" indeterminate />
        </div>
      </Panel>

      <Panel title="Stat tiles">
        <div className="gallery-tiles">
          <StatTile tone="ok" label="2 or more copies elsewhere" value="7.1 GB" detail="Can leave the phone after a checksum check." />
          <StatTile tone="warn" label="Only 1 copy elsewhere (T7)" value="52.1 GB" detail="Gets a second copy on Google Drive first." />
          <StatTile tone="info" label="No copy anywhere" value="1.1 GB" detail="Stays on the phone." />
        </div>
      </Panel>

      <AttentionList label="Attention rows (all severities)">
        <AttentionRow severity="crit" title="Reunion videos have no backup" detail="Only on the laptop." action={<Button>Back up now</Button>} />
        <AttentionRow severity="warn" title="Your phone is almost full" detail="3.6 GB free of 106 GB" action={<Button>Free up space</Button>} />
        <AttentionRow severity="amber" title="2 Drive accounts are full" detail="230 GB free across the other 25 accounts" action={<Button>Review</Button>} />
        <AttentionRow severity="info" title="New drive found" detail="Name it so Backup Hub recognises it later." action={<Button variant="primary">Name this drive</Button>} />
      </AttentionList>

      <Panel title="Coverage bars" footer={<CoverageLegend />}>
        <div className="gallery-stack gallery-stack--narrow">
          <CoverageBar bytes={{ none: 0, one: 45.1, many: 1.4 }} />
          <CoverageBar bytes={{ none: 2.4, one: 25.2, many: 1.2 }} />
          <CoverageBar bytes={{ none: 5, one: 0, many: 0 }} />
          <CoverageBar bytes={{ none: 0, one: 0, many: 9 }} />
        </div>
      </Panel>

      <Panel title="Data table (click a header to sort)" flush>
        <DataTable caption="Demo table" columns={DEMO_COLUMNS} rows={DEMO_ROWS} rowKey={(r) => r.id} stickyHeader />
      </Panel>

      <KitPieces />

      <Panel title="Data table, no rows" flush>
        <DataTable caption="Empty demo table" columns={DEMO_COLUMNS} rows={[]} rowKey={(r) => r.id} emptyText="No collections yet." />
      </Panel>

      <div className="gallery-row">
        <Button variant="quiet" onClick={() => setEmpty((v) => !v)} aria-pressed={empty}>
          Toggle empty state style
        </Button>
      </div>
      {empty ? (
        <EmptyState title="No jobs yet" action={<Button variant="primary">Start a backup</Button>}>
          When you start a backup it shows up here.
        </EmptyState>
      ) : (
        <EmptyState />
      )}
    </>
  );
}
