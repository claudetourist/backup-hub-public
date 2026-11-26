import { useCallback, useEffect, useState } from 'react';
import { QUARANTINE_WORDS } from '../../shared/appFolders';
import { plural, type CleanupOverview } from '../../shared/cleanup';
import { formatGb } from '../../shared/cloudCopy';
import { Button } from '../components/Button';
import { formatBytes } from '../lib/format';
import { lockLeft } from './cleanupModel';

const when = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** What was removed (with what vouched for it), the locks, and the quarantine. Put back, undo and empty live here. */
export function CleanupLog() {
  const [overview, setOverview] = useState<CleanupOverview | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [pick, setPick] = useState<ReadonlySet<number>>(new Set());
  const [emptying, setEmptying] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const load = useCallback(() => {
    void window.backupHub.cleanup.overview().then(setOverview, () => setOverview({ removals: [], locks: [], quarantine: [] }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const putBack = (): void => {
    void (async () => {
      try {
        const phone = await window.backupHub.phone.status();
        const device = phone.adb === 'ready' ? phone.devices.find((d) => d.state === 'device') : undefined;
        if (!device) {
          setMessage({ tone: 'warn', text: 'The phone is not connected and ready. Plug it in, unlock it and try again.' });
          return;
        }
        const result = await window.backupHub.cleanup.putBack({ serial: device.serial, removalIds: [...pick], confirmed: true });
        setMessage({ tone: result.ok ? 'ok' : 'warn', text: result.ok ? 'Putting the files back has started. Watch it in Jobs.' : result.message });
        if (result.ok) setPick(new Set());
      } catch {
        setMessage({ tone: 'warn', text: 'That did not work.' });
      }
    })();
  };

  const waiting = (overview?.removals ?? []).filter((r) => r.kind === 'phone' && r.undoneAt === null);

  return (
    <div className="settings-stack">
      {message ? (
        <p className={`tone-text tone-text--${message.tone}`} role="status">
          {message.text}
        </p>
      ) : null}
      {overview === null ? <p className="cell-sub">Loading…</p> : null}
      {overview && overview.removals.length === 0 ? <p className="cell-sub">Nothing has been removed yet. Every removal will be listed here with what vouched for it.</p> : null}
      {waiting.length > 0 ? (
        <div className="settings-actions">
          <Button variant="secondary" disabled={pick.size === 0} onClick={putBack}>
            Put {plural(pick.size, 'file')} back on the phone
          </Button>
          <span className="cell-sub">Copies the file back from your backup drive and checks it.</span>
        </div>
      ) : null}
      {overview && overview.removals.length > 0 ? (
        <table className="data-table cloud-plan__table" aria-label="Removed files">
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Removed</th>
              <th>Vouched for by</th>
              <th>Now</th>
            </tr>
          </thead>
          <tbody>
            {overview.removals.map((r) => (
              <tr key={r.id}>
                <td className="cloud-plan__path" title={r.path}>
                  {r.kind === 'phone' && r.undoneAt === null ? (
                    <label>
                      <input
                        type="checkbox"
                        checked={pick.has(r.id)}
                        onChange={(event) => {
                          const next = new Set(pick);
                          if (event.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          setPick(next);
                        }}
                      />{' '}
                      {r.path}
                    </label>
                  ) : (
                    r.path
                  )}
                </td>
                <td>{formatBytes(r.size)}</td>
                <td>{when(r.removedAt)}</td>
                <td>{r.vouchedBy}</td>
                <td>
                  {r.kind === 'phone' ? (r.undoneAt !== null ? 'Put back on the phone' : 'Removed from the phone') : r.emptiedAt !== null ? 'Emptied' : r.undoneAt !== null ? 'Put back' : 'In the quarantine'}{' '}
                  {r.canUndo ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        void (async () => {
                          const result = await window.backupHub.cleanup.undo(r.id);
                          setMessage({ tone: result.ok ? 'ok' : 'warn', text: result.message });
                          load();
                        })();
                      }}
                    >
                      Undo
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {overview && overview.quarantine.length > 0 ? (
        <div>
          <h3 className="cloud-plan__head">Quarantine</h3>
          {overview.quarantine.map((b) => (
            <p key={b.date} className="cell-sub">
              <b>{b.date}</b>: {plural(b.files, 'file')} ({formatGb(b.bytes)}) waiting in {QUARANTINE_WORDS}.{' '}
              {b.canAskToEmpty ? (
                emptying === b.date ? (
                  <>
                    <span className="tone-text tone-text--warn">This deletes {plural(b.files, 'file')} for good. </span>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        void (async () => {
                          const result = await window.backupHub.cleanup.emptyQuarantine({ date: b.date, confirmed: true, expectCount: b.files, expectBytes: b.bytes });
                          setMessage({ tone: result.ok ? 'ok' : 'warn', text: result.message });
                          setEmptying(null);
                          load();
                        })();
                      }}
                    >
                      {`Empty ${plural(b.files, 'file')} (${formatGb(b.bytes)})`}
                    </Button>{' '}
                    <Button size="sm" variant="quiet" onClick={() => setEmptying(null)}>
                      Keep them
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setEmptying(b.date)}>
                    These are 30 days old: empty?
                  </Button>
                )
              ) : (
                <span>Backup Hub will ask before emptying, after 30 days. It never empties by itself.</span>
              )}
            </p>
          ))}
        </div>
      ) : null}
      {overview && overview.locks.length > 0 ? (
        <div>
          <h3 className="cloud-plan__head">Locked copies ({overview.locks.length})</h3>
          <p className="cell-sub">These copies vouched for a removal. No clean-up offers them until the lock ends.</p>
          <table className="data-table cloud-plan__table" aria-label="Locked copies">
            <thead>
              <tr>
                <th>Copy</th>
                <th>Place</th>
                <th>Lock</th>
              </tr>
            </thead>
            <tbody>
              {overview.locks.slice(0, 100).map((l) => (
                <tr key={l.id}>
                  <td className="cloud-plan__path" title={l.relPath}>
                    {l.relPath}
                  </td>
                  <td>{l.placeLabel}</td>
                  <td>Locked · {lockLeft(l.expiresAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
