import { useEffect, useState } from 'react';
import { FREEUP_MAX_PUT_BACK, FREEUP_REMOVED_PAGE, type FreeUpRemovedPageResult } from '../../shared/freeUp';
import { formatGb } from '../../shared/cloudCopy';
import { Button } from '../components/Button';
import { formatBytes, formatCount } from '../lib/format';
import { PUT_BACK_HELP, pageTick, putBackButton, putBackConfirmLine, putBackDate, rangeText, removedLine, shortDateTime, shortFolder, tickAllLink, tickOne, tickPage, tickedBytes } from './freeUpModel';

type Page = Extract<FreeUpRemovedPageResult, { ok: true }>;

/**
 * "Removed and not put back": every removed file as a paged table (100 a page) with ticks. The ticks are kept across pages by removal id;
 * the header tick takes the page, "Tick all N" takes every file. One button puts the ticked files back, after a confirm step that says how
 * many and how big. The component is keyed by the totals, so a finished put-back starts it again from the new list.
 */
export function PutBackTable({ backupId, total, onStarted, onMessage }: { backupId: number; total: { files: number; bytes: number }; onStarted: (jobId: number) => void; onMessage: (m: string) => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // The size of every file that was ticked or shown (from a page, or from "Tick all"), for "Put back N ticked (X GB)".
  const [sizes, setSizes] = useState<ReadonlyMap<number, number>>(new Map());

  useEffect(() => {
    let current = true;
    void (async () => {
      const r = await window.backupHub.freeUp.removedPage({ backupId, offset, limit: FREEUP_REMOVED_PAGE }).catch(() => null);
      if (!current || !r?.ok) return;
      setSizes((s) => new Map([...s, ...r.rows.map((row): [number, number] => [row.id, row.size])]));
      setPage(r);
    })();
    return () => {
      current = false;
    };
  }, [backupId, offset]);

  const rows = page?.rows ?? [];
  const state = pageTick(rows, ticked);
  const bytes = tickedBytes(ticked, sizes);
  const all = (): void => {
    setConfirming(false);
    void (async () => {
      try {
        const r = await window.backupHub.freeUp.removedIds({ backupId });
        if (!r.ok) return onMessage(r.message);
        setSizes((s) => new Map([...s, ...r.ids.map((id, i): [number, number] => [id, r.sizes[i] ?? 0])]));
        setTicked(new Set(r.ids));
        if (r.total > r.ids.length) onMessage(`Only the newest ${formatCount(r.ids.length)} of ${formatCount(r.total)} are ticked: put them back, then tick the rest.`);
      } catch {
        onMessage('That did not work. Nothing was changed.');
      }
    })();
  };
  const go = (): void => {
    setBusy(true);
    void (async () => {
      try {
        const r = await window.backupHub.freeUp.putBack({ backupId, removalIds: [...ticked], confirmed: true });
        if (r.ok) onStarted(r.jobId);
        else onMessage(r.message);
      } catch {
        onMessage('That did not work. Nothing was changed.');
      }
      setBusy(false);
      setConfirming(false);
    })();
  };

  return (
    <details className="more" open>
      <summary>{removedLine(total)}</summary>
      <div className="settings-stack">
        <span className="cell-sub">{PUT_BACK_HELP}</span>
        <span className="settings-actions">
          <Button size="sm" variant="quiet" disabled={busy || total.files === 0} onClick={all}>{tickAllLink(Math.min(total.files, FREEUP_MAX_PUT_BACK))}</Button>
          <Button size="sm" variant="quiet" disabled={busy || ticked.size === 0} onClick={() => { setConfirming(false); setTicked(new Set()); }}>Untick all</Button>
        </span>
        {page === null ? <span role="status" className="cell-sub">Reading...</span> : null}
        {page ? (
          <div className="table-scroll table-scroll--virtual free-files">
            <table className="data-table data-table--sticky data-table--virtual" aria-label="Removed files that can be put back">
              <colgroup>
                <col className="put-back-files__tick" />
                <col />
                <col className="free-files__date" />
                <col className="free-files__size" />
                <col className="free-files__where" />
                <col className="put-back-files__removed" />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Tick or untick every file on this page"
                      checked={state === 'all'}
                      ref={(el) => {
                        if (el) el.indeterminate = state === 'some';
                      }}
                      disabled={rows.length === 0}
                      onChange={(e) => {
                        setConfirming(false);
                        setTicked((t) => tickPage(t, rows, e.currentTarget.checked));
                      }}
                    />
                  </th>
                  <th>Name</th>
                  <th>Date taken</th>
                  <th className="is-end">Size</th>
                  <th>Where it was on the phone</th>
                  <th>Removed</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="data-table__empty">No files here.</td>
                  </tr>
                ) : null}
                {rows.map((r) => {
                  const slash = r.path.lastIndexOf('/');
                  const date = putBackDate(r);
                  return (
                    <tr key={r.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Put back ${r.path.slice(slash + 1)}`}
                          checked={ticked.has(r.id)}
                          onChange={(e) => {
                            setConfirming(false);
                            setTicked((t) => tickOne(t, r.id, e.currentTarget.checked));
                          }}
                        />
                      </td>
                      <td title={r.path}>{r.path.slice(slash + 1)}</td>
                      <td title={date.title}>{date.text}</td>
                      <td className="is-end">{formatBytes(r.size)}</td>
                      <td title={r.path.slice(0, Math.max(0, slash))}>{shortFolder(r.path.slice(0, Math.max(0, slash)))}</td>
                      <td>{shortDateTime(r.removedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {page ? (
          <span className="settings-actions">
            {offset > 0 ? <Button size="sm" variant="quiet" onClick={() => setOffset(Math.max(0, offset - FREEUP_REMOVED_PAGE))}>Earlier</Button> : null}
            {offset + rows.length < page.total ? <Button size="sm" variant="quiet" onClick={() => setOffset(offset + FREEUP_REMOVED_PAGE)}>Next</Button> : null}
            <span className="cell-sub">{rangeText(offset, rows.length, page.total)}</span>
          </span>
        ) : null}
        {confirming && ticked.size > 0 ? (
          <>
            <b role="status">{putBackConfirmLine(ticked.size, bytes)}</b>
            <span className="settings-actions">
              <Button variant="primary" disabled={busy} onClick={go}>{`Put back ${formatCount(ticked.size)} (${formatGb(bytes)})`}</Button>
              <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
            </span>
          </>
        ) : (
          <span className="settings-actions">
            <Button disabled={busy || ticked.size === 0} onClick={() => setConfirming(true)}>{putBackButton(ticked.size, bytes)}</Button>
          </span>
        )}
      </div>
    </details>
  );
}
