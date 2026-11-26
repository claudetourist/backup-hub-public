import { useEffect, useMemo, useState } from 'react';
import { restoreDateText, type RestoreDateView, type RestoreEntry } from '../../shared/restore';
import { Button } from '../components/Button';
import { DataTable, type Column } from '../components/DataTable';
import { formatCount } from '../lib/format';
import { childPath, crumbs, entrySize, tickKey, tickedText, toggleTick } from './restoreModel';

type Listing = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ready'; entries: RestoreEntry[]; moreFiles: number };

/** The days of a backup, newest first. */
export function RestoreDays({ dates, day, onPick }: { dates: readonly RestoreDateView[]; day: string | null; onPick: (folder: string) => void }) {
  return (
    <div className="cell-stack cell-stack--tight" role="group" aria-label="Days of this backup">
      <b>Pick a day</b>
      <span className="chips">
        {dates.slice(0, 60).map((d) => (
          <button key={d.folder} type="button" className="chip" aria-pressed={d.folder === day} onClick={() => onPick(d.folder)}>
            {restoreDateText(d.at)}
          </button>
        ))}
      </span>
      {dates.length > 60 ? <span className="cell-sub">The 60 newest days are shown.</span> : null}
    </div>
  );
}

/** The folders and files of one day, with sizes: tick what to bring back. A folder opens with its name; its box takes everything in it. */
export function RestoreBrowser({ backupId, day, ticks, everything, onTicks, onEverything }: { backupId: number; day: string | null; ticks: ReadonlySet<string>; everything: boolean; onTicks: (next: ReadonlySet<string>) => void; onEverything: (on: boolean) => void }) {
  // The parent gives this a new key for each day, so a new day starts at the top.
  const [path, setPath] = useState('');
  const [answer, setAnswer] = useState<{ at: string; listing: Listing } | null>(null);
  const wanted = backupId + '|' + (day ?? '') + '|' + path;
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await window.backupHub.restore.browse({ backupId, folder: day, path });
        if (alive) setAnswer({ at: wanted, listing: r.ok ? { state: 'ready', entries: r.entries, moreFiles: r.moreFiles } : { state: 'failed', message: r.message } });
      } catch {
        if (alive) setAnswer({ at: wanted, listing: { state: 'failed', message: 'The list could not be read.' } });
      }
    })();
    return () => {
      alive = false;
    };
  }, [backupId, day, path, wanted]);
  const listing: Listing = answer !== null && answer.at === wanted ? answer.listing : { state: 'loading' };

  const columns: readonly Column<RestoreEntry>[] = useMemo(
    () => [
      {
        key: 'tick',
        header: 'Get back',
        width: 100,
        render: (e) => <input type="checkbox" className="preview-list__tick" checked={everything || ticks.has(tickKey(path, e))} disabled={everything} tabIndex={-1} aria-label={'Get back ' + e.name} onChange={() => undefined} />,
      },
      {
        key: 'name',
        header: 'Name',
        rowHeader: true,
        render: (e) =>
          e.folder ? (
            <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
              <Button variant="quiet" size="sm" onClick={() => setPath(childPath(path, e.name))}>
                {e.name}
              </Button>
              {e.held > 0 ? <span className="cell-sub"> {formatCount(e.held)} cannot come back</span> : null}
            </span>
          ) : (
            <span className="cell-stack cell-stack--tight">
              <b>{e.name}</b>
              {e.held > 0 ? <span className="cell-sub">Cannot come back: not checked or found different</span> : null}
            </span>
          ),
      },
      { key: 'size', header: 'Size', width: 190, align: 'end', render: (e) => <span className="mono">{entrySize(e)}</span> },
    ],
    [path, ticks, everything],
  );

  return (
    <div className="settings-stack" aria-label="Folders and files">
      <label>
        <input type="checkbox" checked={everything} onChange={(event) => onEverything(event.target.checked)} /> Everything on this day
      </label>
      <nav className="settings-actions" aria-label="Where you are">
        {crumbs(path).map((c, i, all) => (
          <Button key={c.path} variant="quiet" size="sm" disabled={i === all.length - 1} onClick={() => setPath(c.path)}>
            {c.label}
          </Button>
        ))}
      </nav>
      {listing.state === 'loading' ? (
        <p className="cell-sub" role="status">
          Reading the folder…
        </p>
      ) : listing.state === 'failed' ? (
        <p className="cell-sub" role="alert">
          {listing.message}
        </p>
      ) : (
        <>
          <DataTable
            caption="Folders and files of this day"
            columns={columns}
            rows={listing.entries}
            rowKey={(e) => e.name + (e.folder ? '/' : '')}
            emptyText="Nothing here."
            onRowClick={(e) => (everything ? undefined : onTicks(toggleTick(ticks, tickKey(path, e))))}
            virtual={{ height: 320, rowHeight: 44 }}
          />
          {listing.moreFiles > 0 ? <span className="cell-sub">and {formatCount(listing.moreFiles)} more files here, not listed. Tick the folder above to take them all.</span> : null}
        </>
      )}
      <span className="cell-sub" role="status">
        {tickedText(ticks.size, everything)}
      </span>
    </div>
  );
}
