import { useState } from 'react';
import type { BackupsOverview, HistoryPlan, HistoryResult } from '../../shared/backups';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { formatCount } from '../lib/format';
import { historyBroughtInText, readLine, reportHeadline, spareText } from './backupsModel';

type Step = { name: 'idle' } | { name: 'checking' } | { name: 'confirm'; plan: Extract<HistoryPlan, { ok: true }> } | { name: 'running' } | { name: 'done'; result: HistoryResult };

const SHORT_WAIT = 'Reading the history. This can take a minute. Nothing on the drive or in PhoneBackup is changed.';

function HistoryReport({ result }: { result: HistoryResult }) {
  if (!result.ok) {
    return (
      <p role="alert" className="cell-sub">
        {result.message}
      </p>
    );
  }
  const spare = spareText(result.spare);
  return (
    <div className="settings-stack">
      <b>{reportHeadline(result)}</b>
      {result.made.length > 0 ? <span className="cell-sub">Made: {result.made.join(', ')}.</span> : null}
      {result.alreadyThere.length > 0 ? <span className="cell-sub">Already there, left as they were: {result.alreadyThere.join(', ')}.</span> : null}
      <table className="data-table" aria-label="What was brought in">
        <thead>
          <tr>
            <th>Backup</th>
            <th>Rows</th>
            <th>Matched</th>
            <th>No original path</th>
            <th>Could not be matched</th>
          </tr>
        </thead>
        <tbody>
          {result.lines.map((line) => (
            <tr key={line.backup}>
              <td>{line.backup}</td>
              {line.ok ? (
                <>
                  <td>{formatCount(line.rowsIn)}</td>
                  <td>{formatCount(line.linked)}</td>
                  <td>{formatCount(line.loose)}</td>
                  <td>{formatCount(line.stale)}</td>
                </>
              ) : (
                <td colSpan={4}>{line.message}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {result.lines.some((line) => line.staleReasons.length > 0) ? (
        <div className="cell-stack cell-stack--tight">
          <b>Why some rows could not be matched</b>
          {result.lines.map((line) =>
            line.staleReasons.map((reason) => (
              <span key={line.backup + reason.reason} className="cell-sub">
                {line.backup}: {formatCount(reason.count)} {reason.reason}
                {reason.examples.length > 0 ? ' For example: ' + reason.examples.join(', ') : ''}
              </span>
            )),
          )}
        </div>
      ) : null}
      {spare ? <span className="cell-sub">{spare}</span> : null}
      {result.notes.map((note) => (
        <span key={note} className="cell-sub">
          {note}
        </span>
      ))}
    </div>
  );
}


/**
 * "Bring in PhoneBackup history": first shows what will be read and asks for a click; PhoneBackup's files are only read, never changed.
 * Once it was done it is one quiet line with "Bring in again". Nothing here runs by itself.
 */
export function HistoryBringIn({ overview, now, onDone }: { overview: BackupsOverview | null; now: number; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ name: 'idle' });
  const [message, setMessage] = useState<string | null>(null);

  const check = (): void => {
    setStep({ name: 'checking' });
    setMessage(null);
    void (async () => {
      try {
        const plan = await window.backupHub.backups.historyPlan();
        if (plan.ok) setStep({ name: 'confirm', plan });
        else {
          setMessage(plan.message);
          setStep({ name: 'idle' });
        }
      } catch {
        setMessage('That did not work. Nothing was changed.');
        setStep({ name: 'idle' });
      }
    })();
  };

  const run = (): void => {
    setStep({ name: 'running' });
    void (async () => {
      try {
        const result = await window.backupHub.backups.bringInHistory(true);
        setStep({ name: 'done', result });
      } catch {
        setStep({ name: 'done', result: { ok: false, message: 'That did not work. Nothing was changed.' } });
      }
      onDone();
    })();
  };

  const bringInButton = (
    <Button variant={overview?.historyBroughtInAt ? 'quiet' : 'primary'} size={overview?.historyBroughtInAt ? 'sm' : 'md'} onClick={check} disabled={step.name === 'checking' || step.name === 'running'}>
      {overview?.historyBroughtInAt ? 'Bring in again' : 'Bring in PhoneBackup history'}
    </Button>
  );

  if (overview?.historyBroughtInAt && step.name === 'idle') {
    return (
      <div className="settings-stack">
        <span className="cell-sub">
          {historyBroughtInText(overview.historyBroughtInAt, now)} {bringInButton}
        </span>
        {message ? (
          <span role="alert" className="cell-sub">
            {message}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <Panel title="PhoneBackup history">
      <div className="settings-stack">
        <span className="cell-sub">
          The old PhoneBackup kept a record of what it copied. Bring it in so your old backups show up here.
        </span>
        <details className="more">
          <summary>Why?</summary>
          <span className="cell-sub">The record and the drive are only read, never changed. You can do this again later: only new rows are added.</span>
        </details>
        {step.name === 'idle' || step.name === 'checking' ? bringInButton : null}
        {message ? (
          <span role="alert" className="cell-sub">
            {message}
          </span>
        ) : null}
        {step.name === 'confirm' ? (
          <div className="settings-stack" role="group" aria-label="What will be read">
            <b>Backup Hub will read these files on the {step.plan.driveLabel}:</b>
            <ul>
              {step.plan.files.map((file) => (
                <li key={file.path}>
                  {readLine(file)}
                  <span className="cell-sub"> ({file.path})</span>
                </li>
              ))}
            </ul>
            <span className="cell-sub">And PhoneBackup's settings, for the list of backups: {step.plan.settingsPath}</span>
            {step.plan.newBackups.length > 0 ? <span className="cell-sub">These backups will be made: {step.plan.newBackups.join(', ')}.</span> : null}
            {step.plan.stop ? (
              <span role="alert" className="cell-sub">
                {step.plan.stop}
              </span>
            ) : null}
            <span className="settings-actions">
              <Button variant="primary" onClick={run} disabled={step.plan.stop !== null}>
                Bring in
              </Button>
              <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>
                Cancel
              </Button>
            </span>
          </div>
        ) : null}
        {step.name === 'running' ? (
          <span role="status" className="cell-sub">
            {SHORT_WAIT}
          </span>
        ) : null}
        {step.name === 'done' ? (
          <>
            <HistoryReport result={step.result} />
            <span className="settings-actions">
              <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>
                Done
              </Button>
            </span>
          </>
        ) : null}
      </div>
    </Panel>
  );
}
