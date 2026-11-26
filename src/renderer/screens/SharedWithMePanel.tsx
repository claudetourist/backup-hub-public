import { useEffect, useState } from 'react';
import { SHARED_NOT_A_BACKUP, type SharedWithMeOverview } from '../../shared/sharedWithMe';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { formatBytes } from '../lib/format';
import { useSectionOpen } from '../lib/sectionState';

const whenText = (at: number | null): string => (at === null ? 'not checked yet' : `checked ${new Date(at).toLocaleString()}`);

/**
 * Google Drive "shared with me": files other people own. Read only (Backup Hub asks Google for a list and changes nothing there),
 * listed apart from the person's own sources and NEVER counted as a backup copy.
 */
export function SharedWithMePanel({ accountCount }: { accountCount: number }) {
  const [open, toggle] = useSectionOpen('sources.sharedWithMe', false);
  const [data, setData] = useState<SharedWithMeOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const overview = await window.backupHub.shared.overview();
        if (alive) setData(overview);
      } catch {
        // The list simply stays empty.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (accountCount === 0) return null;

  const look = (placeId: string): void => {
    setBusy(placeId);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.shared.look(placeId);
        setMessage(result.message);
        setData(await window.backupHub.shared.overview());
      } catch {
        setMessage('That did not work. Nothing was changed in Google.');
      } finally {
        setBusy(null);
      }
    })();
  };

  const accounts = data?.accounts ?? [];
  const summary = data === null || data.totalItems === 0 ? 'nothing listed' : `${data.totalItems.toLocaleString('en-US')} files`;
  return (
    <Panel title="Shared with me (Google Drive)" headerAside="Read only. Not a backup of your files." collapse={{ open, onToggle: toggle, summary }}>
      <p className="cell-sub">{SHARED_NOT_A_BACKUP} Backup Hub only asks Google for the list; it never copies, changes or removes them.</p>
      <ul className="row-list" aria-label="Google accounts and what is shared with them">
        {accounts.map((a) => (
          <li key={a.placeId} className="row-list__item">
            <span>
              <b>{a.label}</b> <span className="cell-sub">· {a.count.toLocaleString('en-US')} files, {formatBytes(a.bytes)} · {whenText(a.lookedAt)}{a.truncated ? ' · only the first part was read' : ''}</span>
            </span>
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => look(a.placeId)}>
              {busy === a.placeId ? 'Looking…' : 'Look at what is shared'}
            </Button>
          </li>
        ))}
      </ul>
      {message ? (
        <p className="cell-sub" role="status">
          {message}
        </p>
      ) : null}
      {data && data.items.length > 0 ? (
        <table className="data-table" aria-label="Files shared with my Google accounts">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Owner</th>
              <th scope="col">Account</th>
              <th scope="col">Size</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={`${i.placeId}:${i.fileId}`}>
                <td>{i.name}</td>
                <td>{i.owner ?? 'unknown'}</td>
                <td>{i.accountLabel}</td>
                <td>{i.size === null ? '' : formatBytes(i.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {data && data.totalItems > data.items.length ? <p className="cell-sub">Showing the newest {data.items.length.toLocaleString('en-US')} of {data.totalItems.toLocaleString('en-US')}.</p> : null}
    </Panel>
  );
}
