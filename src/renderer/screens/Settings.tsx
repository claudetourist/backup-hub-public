import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ImportV1Info } from '../../shared/importV1';
import { IMPORT_V1_JOB_KIND } from '../../shared/importV1';
import type { TimingsSnapshot } from '../../shared/ipc';
import { HASH_SPEED_CHOICES } from '../../shared/fingerprint';
import type { ThemeSetting } from '../../shared/settings';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { CopyIcon, DriveIcon, FolderIcon, JobsIcon, SettingsIcon } from '../icons';
import { Panel } from '../components/Panel';
import { Toggle } from '../components/Toggle';
import { formatWhen } from '../jobs/jobsModel';
import { useJobs } from '../jobs/JobsProvider';
import { useNow } from '../jobs/useNow';
import { spaceFacts } from '../dataSpace/dataSpaceModel';
import { useDataSpace } from '../dataSpace/useDataSpace';
import { usePlaces } from '../places/PlacesProvider';
import { DrivesAndAccounts } from '../settings/DrivesAndAccounts';
import { useNavigate, useRoute } from '../navContext';
import { ToolsSection } from '../settings/ToolsSection';
import { PeopleSection } from '../settings/PeopleSection';
import { SecuritySection } from './SecuritySection';
import { SharedWithMePanel } from './SharedWithMePanel';
import { DEFAULT_SETTINGS_GROUP, neighbourGroup, SETTINGS_GROUPS, type SettingsGroupId } from './settingsMenu';
import { useSettings } from '../settings/SettingsProvider';

const THEME_CHOICES: readonly { id: ThemeSetting; label: string }[] = [
  { id: 'system', label: 'Match Windows' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** Long explanations stay out of the way: one short line first, the rest behind "More". */
function More({ children }: { children: ReactNode }) {
  return (
    <details className="more">
      <summary>More</summary>
      <span className="cell-sub">{children}</span>
    </details>
  );
}

function Appearance() {
  const { settings, update } = useSettings();
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (run: Promise<string | null>) => setProblem(await run);
  return (
    <Panel title="Appearance and notifications" accent="phone" icon={SettingsIcon}>
      <div className="settings-stack">
        <div className="settings-block">
          <b className="settings-block__title" id="theme-title">
            Theme
          </b>
          <div className="chips" role="group" aria-labelledby="theme-title">
            {THEME_CHOICES.map((choice) => (
              <button key={choice.id} type="button" className="chip" aria-pressed={settings.theme === choice.id} onClick={() => void save(update('theme', choice.id))}>
                {choice.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-block">
          <Toggle
            label="Windows notifications"
            checked={settings.notificationsEnabled}
            hint="A toast when a long job finishes, needs you or fails."
            onChange={(checked) => void save(update('notificationsEnabled', checked))}
          />
        </div>
        {problem ? <span className="tone-text tone-text--crit">{problem}</span> : null}
      </div>
    </Panel>
  );
}

function Performance() {
  const { settings, update } = useSettings();
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (run: Promise<string | null>) => setProblem(await run);
  return (
    <Panel title="Performance and limits" accent="drive" icon={JobsIcon}>
      <div className="settings-stack">
        <div className="settings-block">
          <b className="settings-block__title" id="hash-speed-title">
            Speed limit for matching copies
          </b>
          <div className="chips" role="group" aria-labelledby="hash-speed-title">
            {HASH_SPEED_CHOICES.map((mb) => (
              <button key={mb} type="button" className="chip" aria-pressed={settings.hashMegabytesPerSecond === mb} onClick={() => void save(update('hashMegabytesPerSecond', mb))}>
                {mb === 0 ? 'No limit' : `${mb} MB/s`}
              </button>
            ))}
          </div>
          <span className="cell-sub">The most the laptop reads per second while matching copies. Lower is gentler.</span>
          <More>From 250 MB/s up, two big files are read at once (two cores), and "No limit" reads as fast as the disk allows: it uses more of the laptop.</More>
        </div>
        {problem ? <span className="tone-text tone-text--crit">{problem}</span> : null}
      </div>
    </Panel>
  );
}

function DataRoom() {
  const info = useDataSpace();
  return (
    <Panel title="Room for Backup Hub's data" accent="onedrive" icon={DriveIcon}>
      <div className="settings-stack">
        {info === null ? (
          <p className="cell-sub">Reading the sizes...</p>
        ) : (
          <>
            <dl className="facts">
              {spaceFacts(info).map((fact) => (
                <Fragment key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>
                    {fact.value}
                    {fact.note ? <span className="cell-sub"> {fact.note}</span> : null}
                  </dd>
                </Fragment>
              ))}
            </dl>
            {info.message ? (
              <span className={`tone-text tone-text--${info.level === 'critical' ? 'crit' : 'amber'}`} role="status">
                {info.message}
              </span>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

function DataFolder() {
  const { state } = useSettings();
  return (
    <Panel title="Data folder" accent="laptop" icon={FolderIcon}>
      <div className="settings-stack">
        <dl className="facts">
          <dt>Data</dt>
          <dd>{state?.dataDir ?? '...'}</dd>
          <dt>Logs</dt>
          <dd>{state?.logsDir ?? '...'}</dd>
        </dl>
        <span className="settings-actions">
          <Button disabled={!state} onClick={() => void window.backupHub.settings.openDataFolder().catch(() => undefined)}>
            Open folder
          </Button>
          <span className="cell-sub">Shown here for reference. The data folder stays outside OneDrive and the app folder.</span>
        </span>
      </div>
    </Panel>
  );
}

function ImportSection() {
  const { jobs } = useJobs();
  const now = useNow();
  const [info, setInfo] = useState<ImportV1Info | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.backupHub.importV1
      .info()
      .then((value) => !cancelled && setInfo(value))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const importJobs = jobs.filter((job) => job.kind === IMPORT_V1_JOB_KIND);
  const active = importJobs.find((job) => job.state === 'queued' || job.state === 'running' || job.state === 'needs_you');
  const last = importJobs.find((job) => job.state === 'done' || job.state === 'done_warnings' || job.state === 'failed');

  const start = () => {
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.importV1.start(true);
        if (!result.ok) setMessage(result.message);
        setConfirming(false);
      } catch {
        setMessage('That did not work. Nothing was changed. Please try again.');
      } finally {
        setBusy(false);
      }
    })();
  };

  const lastTone = last?.state === 'failed' ? 'crit' : last?.state === 'done_warnings' ? 'amber' : 'ok';
  return (
    <Panel title="Import" accent="google" icon={CopyIcon} headerAside="From Fleet Manager v1">
      <div className="settings-stack">
        <p>
          Brings your Google accounts and their Drive file list from the Fleet Manager v1 archive copy. It reads only the archived copy;
          Fleet Manager v1 is not changed. No files are copied or uploaded, and nothing is deleted. Accounts that Backup Hub has
          already refreshed or signed in again itself are left exactly as they are.
        </p>
        <dl className="facts">
          <dt>Reads from</dt>
          <dd>{info?.sourceDir ?? '...'}</dd>
          <dt>Archive found</dt>
          <dd>{info === null ? '...' : info.sourceFound ? 'Yes' : 'No'}</dd>
        </dl>
        {confirming ? (
          <div className="confirm-box" role="group" aria-label="Confirm the import">
            <p>
              <b>Bring in the accounts and file list now?</b> Backup Hub makes a temporary copy of the archived files, unlocks the saved
              sign-ins with your Windows account, saves them in its own protected store, and lists each account's files. It does not
              contact Google, copy or upload any file, or delete anything. Accounts Backup Hub has already refreshed or signed in again
              itself are skipped, so their newer sign-in, space numbers and file lists are never replaced by the old v1 ones.
            </p>
            <span className="inline-edit__buttons">
              <Button variant="primary" size="sm" disabled={busy} onClick={start}>
                Yes, bring them in
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Not now
              </Button>
            </span>
          </div>
        ) : (
          <span className="settings-actions">
            <Button
              disabled={busy || active !== undefined || info === null || !info.sourceFound}
              onClick={() => {
                setMessage(null);
                setConfirming(true);
              }}
            >
              Bring in from Fleet Manager v1
            </Button>
            {active ? (
              <span className="cell-sub" role="status">
                Running: {active.message ?? 'starting'} (see Jobs)
              </span>
            ) : null}
          </span>
        )}
        {message ? (
          <span className="tone-text tone-text--warn" role="alert">
            {message}
          </span>
        ) : null}
        {last ? (
          <p className={`tone-text tone-text--${lastTone}`} role="status">
            Last import {last.finishedAt ? formatWhen(last.finishedAt, now) : ''}:{' '}
            {last.state === 'failed' ? (last.error ?? 'it did not finish.') : (last.message ?? 'finished.')}
            {last.state === 'done_warnings' ? ` ${last.warnings.length} ${last.warnings.length === 1 ? 'note' : 'notes'} in Jobs.` : ''}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

/** Google Drive "shared with me" (moved here from Devices): read only, never counted as a copy. */
function SharedWithMeSection() {
  const { snapshot } = usePlaces();
  return <SharedWithMePanel accountCount={(snapshot?.places ?? []).filter((p) => p.kind === 'gdrive').length} />;
}

/** Small diagnostics panel; proves the typed preload bridge works end to end. */
function BuildInfo() {
  const [version, setVersion] = useState<string | null>(null);
  const [timings, setTimings] = useState<TimingsSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.backupHub.app
      .version()
      .then((v) => !cancelled && setVersion(v))
      .catch(() => undefined);
    window.backupHub.app
      .timings()
      .then((t) => !cancelled && setTimings(t))
      .catch(() => undefined);
    const off = window.backupHub.onEvent('timings:updated', setTimings);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const marks = timings?.marks ?? {};
  return (
    <section className="panel" aria-label="This build">
      <h2 className="panel__title">This build</h2>
      <dl className="facts">
        <dt>Version</dt>
        <dd>{version ?? '...'}</dd>
        <dt>App ready</dt>
        <dd>{marks.appReady === undefined ? '...' : `${Math.round(marks.appReady)} ms`}</dd>
        <dt>Window shown</dt>
        <dd>{marks.readyToShow === undefined ? '...' : `${Math.round(marks.readyToShow)} ms`}</dd>
        <dt>First paint</dt>
        <dd>{marks.firstPaint === undefined ? '...' : `${Math.round(marks.firstPaint)} ms`}</dd>
      </dl>
    </section>
  );
}

export default function Settings() {
  // The group is part of the address (#/settings/security), so back and forward move between groups.
  const route = useRoute();
  const navigate = useNavigate();
  const group: SettingsGroupId = SETTINGS_GROUPS.find((g) => g.id === route.sub)?.id ?? DEFAULT_SETTINGS_GROUP;
  const setGroup = (next: SettingsGroupId): void => navigate('settings', next);
  const refs = useRef<Partial<Record<SettingsGroupId, HTMLButtonElement | null>>>({});
  const move = (step: 1 | -1): void => {
    const next = neighbourGroup(group, step);
    setGroup(next);
    refs.current[next]?.focus();
  };
  return (
    <>
      <PageHeader icon={SettingsIcon} cat="google" eyebrow="Preferences" title="Settings" subtitle="Pick a group on the left." />
      <div className="settings-layout">
        <nav className="settings-menu" aria-label="Settings groups">
          {SETTINGS_GROUPS.map((g) => (
            <button
              key={g.id}
              ref={(node) => {
                refs.current[g.id] = node;
              }}
              type="button"
              className="settings-menu__item"
              aria-current={g.id === group ? 'page' : undefined}
              onClick={() => setGroup(g.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  move(1);
                } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                  event.preventDefault();
                  move(-1);
                }
              }}
            >
              {g.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {group === 'appearance' ? (
            <>
              <Appearance />
              <BuildInfo />
            </>
          ) : null}
          {group === 'drives' ? <DrivesAndAccounts /> : null}
          {group === 'performance' ? <Performance /> : null}
          {group === 'people' ? <PeopleSection /> : null}
          {group === 'security' ? <SecuritySection /> : null}
          {group === 'tools' ? <ToolsSection /> : null}
          {group === 'advanced' ? (
            <>
              <DataRoom />
              <DataFolder />
              <ImportSection />
              <SharedWithMeSection />
              <BuildInfo />
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
