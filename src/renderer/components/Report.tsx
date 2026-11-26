import { formatBytes, formatCount, plural } from '../lib/format';
import { reasonTotal, reportHeadline, reportOutcome, type ReportData, type ReportReason } from './reportModel';

function ReasonList({ reasons }: { reasons: readonly ReportReason[] }) {
  return (
    <ul className="report__reasons">
      {reasons.map((reason) => (
        <li key={reason.reason}>
          <b>{formatCount(reason.count)}</b> {reason.reason}
          {reason.examples && reason.examples.length > 0 ? <span className="cell-sub report__examples">For example: {reason.examples.join(', ')}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** What a finished run tells the person: copied, skipped and why, failed and why, where it went (PLAN section 6). */
export function Report({ data, title = 'Report' }: { data: ReportData; title?: string }) {
  const outcome = reportOutcome(data);
  const skipped = reasonTotal(data.skipped);
  const failed = reasonTotal(data.failed);
  return (
    <section className={`report report--${outcome}`} aria-label={title}>
      <header className="report__head">
        <h2 className="report__headline">{reportHeadline(data)}</h2>
        {data.finished ? <span className="cell-sub">Finished {data.finished}</span> : null}
      </header>
      <div className="report__block">
        <h3 className="report__label">Copied</h3>
        <p>
          {formatCount(data.copied.files)} {plural(data.copied.files, 'file', 'files')}, {formatBytes(data.copied.bytes)}
        </p>
      </div>
      <div className="report__block">
        <h3 className="report__label">Skipped</h3>
        {skipped === 0 ? <p>Nothing was skipped.</p> : <ReasonList reasons={data.skipped} />}
      </div>
      <div className="report__block">
        <h3 className="report__label">Failed</h3>
        {failed === 0 ? <p>Nothing failed.</p> : <ReasonList reasons={data.failed} />}
      </div>
      <div className="report__block">
        <h3 className="report__label">Where it went</h3>
        {data.where.length === 0 ? (
          <p>Nothing was written.</p>
        ) : (
          <ul className="report__reasons">
            {data.where.map((place) => (
              <li key={place}>{place}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
