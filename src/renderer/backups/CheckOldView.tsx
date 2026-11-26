import type { ReactNode } from 'react';
import type { CheckOldCountsResult, CheckOldPlanResult, CheckOldReport } from '../../shared/phoneBackup';
import { CHECK_OLD_PROMISE } from '../../shared/phoneBackup';
import { Button } from '../components/Button';
import { tickedOfText } from '../components/previewModel';
import { breakdownText, CHECK_OLD_PREVIEW_HEADLINE, confirmText, folderLine, folderTickLine, foldTitle, headlineText, lookedAtText, namedRows, neverRead, neverReadText, reportLines, reportTitle, selectionTotals, tickedFolders } from './checkOldModel';

type Counts = Extract<CheckOldCountsResult, { ok: true }>;
type Plan = Extract<CheckOldPlanResult, { ok: true }>;

/**
 * The headline line of the backup's card with the button that opens the preview right next to it, then the "By folder" fold (closed; the
 * breakdown sentence is at its top). `backupName` is the backup's own
 * name. A phone that was never read has no numbers to show: one plain sentence, and no button.
 */
export function CheckOldHeadline({ backupName, counts, formatWhen, action }: { backupName: string; counts: Counts; formatWhen: (ms: number) => string; action: ReactNode }) {
  if (neverRead(counts.total)) {
    return (
      <div className="cell-stack cell-stack--tight" role="group" aria-label="Checked copies">
        <span className="cell-sub">{neverReadText(backupName)}</span>
      </div>
    );
  }
  const rest = breakdownText(counts.total);
  const asOf = lookedAtText(counts.lookedAt, formatWhen);
  return (
    <div className="cell-stack cell-stack--tight" role="group" aria-label="Checked copies">
      <span className="settings-actions">
        <b>{headlineText(backupName, counts.driveLabel, counts.total)}</b>
        {action}
      </span>
      {rest || asOf || counts.folders.length > 0 ? (
        <details className="more">
          <summary>By folder</summary>
          <div className="cell-stack cell-stack--tight">
            {rest ? <span className="cell-sub">{rest}</span> : null}
            {asOf ? <span className="cell-sub">{asOf}</span> : null}
            {counts.folders.map((f) => (
              <span key={f.folder} className="cell-sub">
                {folderLine(f)}
              </span>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** The preview before the check: the folders with copies not checked yet, ticks, the promise, the one button. */
export function CheckOldPreview({ plan, unticked, onToggle, onTickAll, onUntickAll, onConfirm, onCancel, busy }: { plan: Plan; unticked: ReadonlySet<string>; onToggle: (folder: string) => void; onTickAll: () => void; onUntickAll: () => void; onConfirm: () => void; onCancel: () => void; busy: boolean }) {
  const sel = selectionTotals(plan.folders, unticked);
  const ticked = tickedFolders(plan.folders, unticked);
  return (
    <div className="cell-stack cell-stack--tight" role="group" aria-label="Check old copies">
      <b>{CHECK_OLD_PREVIEW_HEADLINE}</b>
      <span className="preview-list__bulk">
        <Button size="sm" variant="quiet" disabled={ticked === 0} onClick={onUntickAll}>
          Untick all
        </Button>
        <Button size="sm" variant="quiet" disabled={ticked === plan.folders.length} onClick={onTickAll}>
          Tick all
        </Button>
      </span>
      <span className="cell-sub" role="status">
        {tickedOfText(ticked, plan.folders.length)}
      </span>
      {plan.folders.map((f) => (
        <label key={f.folder} className="cell-sub">
          <input type="checkbox" checked={!unticked.has(f.folder)} onChange={() => onToggle(f.folder)} /> {folderTickLine(f)}
        </label>
      ))}
      <span className="cell-sub">{CHECK_OLD_PROMISE}</span>
      <span className="settings-actions">
        <Button variant="primary" disabled={busy || sel.files === 0} onClick={onConfirm}>
          {confirmText(sel)}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/** What the check found, in plain sentences; the files that differ and the ones missing on the drive are named in folds. */
export function CheckOldReportView({ report, formatWhen }: { report: CheckOldReport; formatWhen: (ms: number) => string }) {
  const differ = namedRows(report.differ);
  const missing = namedRows(report.missing);
  return (
    <section className="cell-stack cell-stack--tight" aria-label="Check old copies report">
      <b>{reportTitle(report)}</b>
      <span className="cell-sub">Finished {formatWhen(report.finishedAt)}. Nothing on the phone or on {report.driveLabel} was copied, changed or removed.</span>
      {reportLines(report).map((line) => (
        <span key={line.key} className="cell-sub" {...(line.tone === 'warn' ? { role: 'alert' } : {})}>
          {line.text}
        </span>
      ))}
      {differ.length > 0 ? (
        <details className="more">
          <summary>{foldTitle('Files that differ', report.differCount, differ.length)}</summary>
          <div className="cell-stack cell-stack--tight">
            {differ.map((f) => (
              <span key={f.key} className="cell-sub">
                {f.name} ({f.folder}, {f.size})
              </span>
            ))}
          </div>
        </details>
      ) : null}
      {missing.length > 0 ? (
        <details className="more">
          <summary>{foldTitle('Files missing on the drive', report.missingCount, missing.length)}</summary>
          <div className="cell-stack cell-stack--tight">
            {missing.map((f) => (
              <span key={f.key} className="cell-sub">
                {f.name} ({f.folder}, {f.size})
              </span>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
