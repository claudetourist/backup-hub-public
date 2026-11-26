import { secondHint } from './mirrorModel';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../components/Button';
import { BACKUP_KIND_CATEGORY, BACKUP_KIND_LABEL } from '../components/backupKinds';
import { OwnerChip } from '../components/OwnerChip';
import { PageHeader } from '../components/PageHeader';
import { ProgressBar } from '../components/ProgressBar';
import { StatusPill } from '../components/StatusPill';
import { pauseWords } from '../../shared/jobs';
import { CloudIcon, DriveIcon, LaptopIcon, PhoneIcon } from '../icons';
import { useOwnerActions } from '../profiles/useOwnerActions';
import { BackupOverview } from './BackupOverview';
import { CheckOldCopies } from './CheckOldCopies';
import { FolderBackupPanel } from './FolderBackupPanel';
import { GooglePanel } from './GooglePanel';
import { HistoryTab } from './HistoryTab';
import { MirrorCheckPanel } from './MirrorCheckPanel';
import { MirrorPanel } from './MirrorPanel';
import { NotCoveredCard } from './NotCoveredCard';
import { FreeUpPanel } from './FreeUpPanel';
import { PhoneBackupPanel } from './PhoneBackupPanel';
import { SafeToUnplugNote } from '../places/SafeUnplug';
import { RestorePanel } from './RestorePanel';
import { YourChoicesPanel } from './YourChoicesDrawer';
import { buildEntries, resumeOf, tabsFor, type BackupAddress, type BackupEntry, type BackupTab } from './backupListModel';
import type { BackupsData } from './useBackupsData';

const KIND_ICONS = { phone: PhoneIcon, laptop: LaptopIcon, cloud: CloudIcon, drive: DriveIcon } as const;

/** The running job of this backup: what it is doing, how far, and Pause / Stop (or the answers it waits for). */
function RunningJob({ entry }: { entry: BackupEntry }) {
  const job = entry.job;
  const [problem, setProblem] = useState<string | null>(null);
  if (!job || entry.progress === null) return null;
  const act = (run: () => Promise<unknown>): void => void run().catch(() => setProblem('That did not work. Please try again.'));
  return (
    <div className="bk-running" role="status">
      <span className="bk-running__line">
        <b>{entry.progress}</b>
        <span className="settings-actions">
          {job.state === 'needs_you' ? (
            (job.choices.length > 0 ? job.choices : ['Continue']).map((c) => (
              <Button key={c} size="sm" variant="primary" onClick={() => act(() => window.backupHub.jobs.resolve(job.id, c))}>
                {c}
              </Button>
            ))
          ) : job.paused ? (
            <>
              <span className="cell-sub">{pauseWords(job)}</span>
              <Button size="sm" variant="secondary" onClick={() => act(() => window.backupHub.jobs.resume(job.id))}>
                Resume
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => act(() => window.backupHub.jobs.pause(job.id))}>
              Pause
            </Button>
          )}
          <Button size="sm" variant="quiet" onClick={() => act(() => window.backupHub.jobs.cancel(job.id))}>
            Stop
          </Button>
        </span>
      </span>
      {job.state === 'needs_you' && job.message ? <span className="cell-sub">{job.message}</span> : null}
      {entry.percent !== null ? <ProgressBar label={entry.progress} value={entry.percent} valueText={entry.progress} /> : <ProgressBar label={entry.progress} indeterminate />}
      {problem ? <span role="alert" className="cell-sub">{problem}</span> : null}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="cell-sub" role="status">{children}</p>;
}

/**
 * #/backups/<id>: one backup in detail. A Back button and the title "Backups > name", the header (kind, owner, status, where, last run, numbers, the job that is
 * running now), and sections. A section loads when it is first opened and stays (hidden) after that, so a list or a running copy is not lost when you look at another.
 */
export function BackupPage({ data, address, onBack }: { data: BackupsData; address: BackupAddress; onBack: () => void }) {
  const { rows, now, mirror, sizes, jobs, connected, folderCards, profiles } = data;
  const row = rows?.find((r) => r.id === address.id) ?? null;
  const [tab, setTab] = useState<BackupTab>(address.tab);
  const [visited, setVisited] = useState<ReadonlySet<BackupTab>>(() => new Set<BackupTab>(['overview', address.tab]));
  // Goes up each time a button asked to start at once: the section is made again so its panel looks at once.
  const [go, setGo] = useState<{ tab: BackupTab; n: number } | null>(address.go ? { tab: address.tab, n: 1 } : null);
  const [rulesVersion, setRulesVersion] = useState(0);
  const { setBackupOwner } = useOwnerActions();

  const openTab = useCallback((next: BackupTab, start: boolean): void => {
    setTab(next);
    setVisited((cur) => (cur.has(next) ? cur : new Set([...cur, next])));
    if (start) setGo((g) => ({ tab: next, n: (g?.n ?? 0) + 1 }));
  }, []);

  // The address keeps the part that was asked for but not the "start at once": going forward to it again must not start a look.
  useEffect(() => {
    if (address.go) window.history.replaceState(null, '', `#/backups/${encodeURIComponent(`${address.id}/${address.tab}`)}`);
  }, [address]);

  // Alt+Left goes back, like the Back button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const entry = useMemo(() => (row ? buildEntries([row], { now, mirror, sizes, jobs, connected, ownerNames: new Map(profiles.map((p) => [p.id, p.name] as const)) })[0]! : null), [row, now, mirror, sizes, jobs, connected, profiles]);

  const back = (
    <nav className="bk-back" aria-label="Back to the list">
      <Button variant="secondary" size="sm" onClick={onBack} title="Back to all backups (Alt+Left)">
        ← Back
      </Button>
    </nav>
  );

  if (row === null || entry === null) {
    return (
      <>
        {back}
        <PageHeader eyebrow="Backups" title="Backups" />
        <div className="devices">
          {rows === null ? <Note>Reading the backup…</Note> : <Note>This backup is not on the list. It may belong to another person (switch the person at the top left), or it was removed from the list.</Note>}
        </div>
      </>
    );
  }

  const tabs = tabsFor(row);
  const plugged = row.kind === 'phone' ? (connected?.phones.find((p) => p.backupId === row.id) ?? null) : null;
  const card = row.kind === 'folder' ? (folderCards?.cards.find((c) => c.backupId === row.id) ?? null) : null;
  const second = (row.destinations?.length ?? 1) > 1;
  const secondLabel = row.destinations?.[1]?.label ?? null;
  const goFor = (t: BackupTab): { key: string; start: boolean } => ({ key: `${t}${go?.tab === t ? go.n : 0}`, start: go?.tab === t });
  const owner = profiles.find((p) => p.id === row.personId) ?? null;
  const Icon = KIND_ICONS[entry.kind];
  const hint = secondHint(mirror?.backups.find((m) => m.backupId === row.id));

  const content = (id: BackupTab): ReactNode => {
    switch (id) {
      case 'overview':
        return <BackupOverview entry={entry} data={data} onTab={openTab} onRemoved={onBack} />;
      case 'backup': {
        if (!row.enabled) return <Note>This backup is switched off.</Note>;
        const g = goFor('backup');
        if (row.kind === 'phone') {
          return plugged ? (
            <PhoneBackupPanel key={g.key} phone={plugged} embedded autoStart={g.start} fromOldTool={row.fromOldTool === true} resume={resumeOf(jobs, row.id, { look: 'phone.look', run: 'phone.backup' }, row.driveLabel)} onFinished={data.load} onChoicesChanged={data.load} rulesVersion={rulesVersion} onOpenChoices={() => openTab('choices', false)} onReleased={data.checkPhones} />
          ) : (connected?.released?.length ?? 0) > 0 ? (
            <div className="settings-stack">
              <SafeToUnplugNote onChanged={data.checkPhones} />
            </div>
          ) : (
            <div className="settings-stack">
              <span className="cell-sub">{connected?.adb === 'missing' ? 'Backup Hub cannot find the program it needs to talk to a phone (adb).' : (connected?.hint ?? `${row.name} is not plugged in. Plug it in with the cable and unlock it.`)}</span>
              <span className="settings-actions">
                <Button onClick={data.checkPhones}>Check for a phone</Button>
              </span>
            </div>
          );
        }
        if (folderCards === null) return <Note>Reading the folder backups…</Note>;
        return card ? (
          <FolderBackupPanel key={g.key} card={card} embedded autoStart={g.start} fromOldTool={row.fromOldTool === true} resume={resumeOf(jobs, row.id, { look: 'folder.look', run: 'folder.backup' }, row.driveLabel)} onFinished={data.load} onChoicesChanged={data.load} rulesVersion={rulesVersion} onOpenChoices={() => openTab('choices', false)} />
        ) : (
          <Note>This folder cannot be backed up from here right now.</Note>
        );
      }
      case 'second': {
        const g = goFor('second');
        return <MirrorPanel key={g.key} rows={[row]} status={mirror} now={now} onFinished={data.load} onShowCheck={() => openTab('check', false)} {...(g.start ? { autoStart: row.id } : {})} resume={resumeOf(jobs, row.id, { look: 'mirror.look', run: 'mirror.copy' }, secondLabel)} />;
      }
      case 'check': {
        const g = goFor('check');
        return (
          <div className="settings-stack">
            {row.kind === 'phone' ? (
              <div className="settings-stack">
                {second ? <b>Copies on {row.driveLabel}</b> : null}
                {plugged ? <CheckOldCopies phone={plugged} onFinished={data.load} /> : <Note>Plug in {row.name} to check its old copies on {row.driveLabel ?? 'the drive'}.</Note>}
              </div>
            ) : null}
            {second ? (
              <div className="settings-stack">
                {row.kind === 'phone' ? <b>Copies on {secondLabel}</b> : null}
                <MirrorCheckPanel key={g.key} rows={[row]} status={mirror} onFinished={data.load} {...(g.start ? { autoStart: row.id } : {})} resume={resumeOf(jobs, row.id, { look: 'mirror.none', run: 'mirror.checkOld' }, secondLabel)} />
              </div>
            ) : null}
          </div>
        );
      }
      case 'google': {
        const g = goFor('google');
        return <GooglePanel key={g.key} backupId={row.id} onFinished={data.load} resume={resumeOf(jobs, row.id, { look: 'google.none', run: 'google.copy' }, null)} />;
      }
      case 'choices':
        return <YourChoicesPanel backupId={row.id} onChanged={() => { data.load(); setRulesVersion((v) => v + 1); }} />;
      case 'covered':
        return <NotCoveredCard backupId={row.id} framed={false} open />;
      case 'history':
        return <HistoryTab row={row} jobs={jobs} now={now} />;
      case 'free':
        return <FreeUpPanel backupId={row.id} backupName={row.name} />;
      case 'restore':
        return <RestorePanel backupId={row.id} onFinished={data.load} />;
    }
  };

  return (
    <>
      {back}
      <PageHeader icon={Icon} cat={BACKUP_KIND_CATEGORY[entry.kind]} eyebrow={BACKUP_KIND_LABEL[entry.kind]} title={`Backups > ${row.name}`} />
      <div className="devices">
        <section className={`bk-head cat--${BACKUP_KIND_CATEGORY[entry.kind]}`} aria-label="About this backup">
          <span className="bk-head__line">
            <OwnerChip what={`the backup ${row.name}`} owner={owner} people={profiles} onChoose={(personId) => void setBackupOwner(row.id, personId).then((ok) => (ok ? data.load() : undefined))} />
            {entry.status ? <StatusPill status={entry.status} /> : <span className="cell-sub">Switched off</span>}
            <span>{entry.last}</span>
            <span className="cell-sub">{entry.numbers}</span>
          </span>
          <span className="cell-sub">{entry.source} · {entry.kept}{entry.note ? ` · ${entry.note}` : ''}</span>
          {hint && tab !== 'second' ? (
            <span className="bk-head__line" role="status">
              <span className="cell-sub"><b>{hint.text}</b></span>
              <Button size="sm" variant={hint.ready ? 'primary' : 'secondary'} onClick={() => openTab('second', false)}>Open Second copy</Button>
            </span>
          ) : null}
          <RunningJob entry={entry} />
        </section>
        <div className="bk-tabs" role="tablist" aria-label="Sections of this backup">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" id={`bk-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`bk-panel-${t.id}`} className="bk-tab" onClick={() => openTab(t.id, false)}>
              {t.label}
              {t.id === 'choices' && row.choices > 0 ? ` (${row.choices})` : ''}
            </button>
          ))}
        </div>
        {tabs.map((t) =>
          visited.has(t.id) ? (
            <section key={t.id} className="bk-panel" role="tabpanel" id={`bk-panel-${t.id}`} aria-labelledby={`bk-tab-${t.id}`} hidden={tab !== t.id}>
              {content(t.id)}
            </section>
          ) : null,
        )}
      </div>
    </>
  );
}
