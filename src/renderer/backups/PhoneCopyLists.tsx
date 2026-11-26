import { useEffect, useState, type ReactNode } from 'react';
import type { CopiedFiles, PhoneBackupProgress, ProgressFailed, ProgressFile } from '../../shared/phoneBackup';
import { DataTable, type Column } from '../components/DataTable';
import { formatBytes } from '../lib/format';
import { WhyLink } from '../why/WhyLink';
import { phoneFileRequest } from '../why/whyModel';
import { cappedNote, copiedFoldTitle, copiedRows, copyingNowText, doneTitle, filesDoneText, notCopiedTitle, progressRow, PROGRESS_POLL_MS, stillToCopyTitle, type CopiedRow } from './phoneBackupModel';

/** Which backup's calls a piece talks to: a phone backup or a folder backup (the lists look the same). */
export type BackupKind = 'phone' | 'folder';

/**
 * Asks main how a running copy is going, once a second, until the run ends or the window leaves the screen (no timer is left behind).
 * Read only. Keeps the last answer when one call fails or comes back empty.
 */
export function useRunProgress(jobId: number | null, live: boolean, kind: BackupKind = 'phone'): PhoneBackupProgress | null {
  const [progress, setProgress] = useState<PhoneBackupProgress | null>(null);
  useEffect(() => {
    if (jobId === null || !live) return;
    let stopped = false;
    let busy = false;
    let timer: number | undefined;
    const ask = async (): Promise<void> => {
      if (busy || stopped) return;
      busy = true;
      try {
        const next = await (kind === 'folder' ? window.backupHub.folderBackup : window.backupHub.phoneBackup).progress(jobId);
        if (stopped) return;
        if (next !== null) setProgress(next);
        if (next?.finished) {
          stopped = true;
          window.clearInterval(timer);
        }
      } catch {
        // Keep what is on screen; the next call tries again.
      } finally {
        busy = false;
      }
    };
    void ask();
    timer = window.setInterval(() => void ask(), PROGRESS_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, live, kind]);
  return progress;
}

/** What goes right under the progress bar: the file being copied now, and how many files are finished. */
export function CopyingNow({ progress }: { progress: PhoneBackupProgress | null }) {
  if (progress === null) return <span className="cell-sub">Getting the list of files ready.</span>;
  return (
    <div className="phone-now" role="status">
      <b className="phone-now__file">{copyingNowText(progress.current)}</b>
      <span className="cell-sub">{filesDoneText(progress)} finished</span>
    </div>
  );
}

function FileLine({ file, mark, reason, backupId }: { file: ProgressFile; mark?: 'done' | 'failed'; reason?: string; backupId?: number | undefined }) {
  const row = progressRow(file);
  return (
    <li className={mark === 'failed' ? 'phone-line phone-line--failed' : 'phone-line'}>
      {mark === 'done' ? (
        <span className="phone-line__mark phone-line__mark--ok" aria-label="Copied and checked" role="img">
          ✓
        </span>
      ) : null}
      {mark === 'failed' ? (
        <span className="phone-line__mark phone-line__mark--bad" aria-label="Not copied" role="img">
          ✕
        </span>
      ) : null}
      <span className="phone-file">
        <b className="phone-file__name">{row.name}</b>
        {reason ? <span className="phone-file__reason">{reason}</span> : <span className="phone-file__folder">{row.folder}</span>}
      </span>
      <span className="mono phone-line__size">{formatBytes(row.size)}</span>
      {backupId !== undefined ? <WhyLink request={phoneFileRequest(backupId, file.path)} name={row.name} /> : null}
    </li>
  );
}

function ListBox({ title, note, children, empty }: { title: string; note: string | null; children: ReactNode; empty: string | null }) {
  return (
    <div className="phone-listbox">
      <b>{title}</b>
      {empty ? (
        <span className="cell-sub">{empty}</span>
      ) : (
        <ul className="phone-listbox__list" aria-label={title}>
          {children}
        </ul>
      )}
      {note ? <span className="cell-sub">{note}</span> : null}
    </div>
  );
}

/** The files still to copy (in copy order), the files done (newest first) with a tick, and the ones not copied with the reason. */
export function CopyLists({ progress, backupId }: { progress: PhoneBackupProgress | null; backupId?: number | undefined }) {
  if (progress === null) return null;
  return (
    <div className="phone-lists">
      <ListBox title={stillToCopyTitle(progress)} note={cappedNote(progress.next.length, progress.waiting)} empty={progress.next.length === 0 ? 'No more files waiting.' : null}>
        {progress.next.map((f) => (
          <FileLine key={f.path} file={f} backupId={backupId} />
        ))}
      </ListBox>
      <ListBox title={doneTitle(progress)} note={cappedNote(progress.recent.length, progress.done)} empty={progress.recent.length === 0 ? 'Nothing is finished yet.' : null}>
        {progress.recent.map((f) => (
          <FileLine key={f.path} file={f} mark="done" backupId={backupId} />
        ))}
      </ListBox>
      {progress.failedCount > 0 ? (
        <ListBox title={notCopiedTitle(progress)} note={cappedNote(progress.failed.length, progress.failedCount)} empty={null}>
          {progress.failed.map((f: ProgressFailed) => (
            <FileLine key={f.path} file={f} mark="failed" reason={f.reason} backupId={backupId} />
          ))}
        </ListBox>
      ) : null}
    </div>
  );
}

const copiedColumns = (backupId: number | undefined): readonly Column<CopiedRow>[] => [
  {
    key: 'name',
    header: 'File and folder',
    rowHeader: true,
    render: (row) => (
      <span className="phone-file">
        <b className="phone-file__name">{row.name}</b>
        <span className="phone-file__folder">{row.folder}</span>
      </span>
    ),
  },
  { key: 'size', header: 'Size', width: 92, align: 'end', render: (row) => <span className="mono">{formatBytes(row.size)}</span> },
  { key: 'date', header: 'Date', width: 128, render: (row) => row.date },
  ...(backupId !== undefined ? [{ key: 'why', header: 'Why?', width: 76, render: (row: CopiedRow) => <WhyLink request={phoneFileRequest(backupId, row.key)} name={row.name} /> }] : []),
];

/** In the report: "Show all copied files". The list is only fetched when the fold is opened. */
export function CopiedFilesFold({ jobId, copiedCount, backupId, kind = 'phone' }: { jobId: number; copiedCount: number; backupId?: number | undefined; kind?: BackupKind }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<CopiedFiles | null>(null);
  const [problem, setProblem] = useState(false);
  useEffect(() => {
    if (!open || files !== null) return;
    let stopped = false;
    void (async () => {
      try {
        const result = await (kind === 'folder' ? window.backupHub.folderBackup : window.backupHub.phoneBackup).copied(jobId);
        if (!stopped) setFiles(result);
        if (!stopped && result === null) setProblem(true);
      } catch {
        if (!stopped) setProblem(true);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [open, files, jobId, kind]);
  const rows = files ? copiedRows(files.files) : [];
  return (
    <details className="more" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{copiedFoldTitle(copiedCount)}</summary>
      {open ? (
        problem ? (
          <span role="alert" className="cell-sub">The list of copied files could not be read. The copies themselves are fine.</span>
        ) : files === null ? (
          <span role="status" className="cell-sub">Reading the list.</span>
        ) : (
          <>
            <DataTable caption="Files copied in this backup" columns={copiedColumns(backupId)} rows={rows} rowKey={(row) => row.key} virtual={{ height: 360, rowHeight: 56 }} emptyText="No files were copied." />
            {cappedNote(files.files.length, files.total) ? <span className="cell-sub">{cappedNote(files.files.length, files.total)} The full list is on the drive.</span> : null}
          </>
        )
      ) : null}
    </details>
  );
}
