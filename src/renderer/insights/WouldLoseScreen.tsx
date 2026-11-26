import { useEffect, useState } from 'react';
import type { LoseKind, LosePart, LoseSection, WouldLoseDetail } from '../../shared/insights';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { Skeleton } from '../components/Skeleton';
import { StatTile } from '../components/StatTile';
import { TextField } from '../components/TextField';
import { SourcesIcon } from '../icons';
import { formatBytes } from '../lib/format';
import { useNavigate } from '../navContext';
import { usePlaces } from '../places/PlacesProvider';
import { countLine, folderLine, kindLabel, loseChoices, loseHeadline, loseSub, PART_HELP, PART_WORDS } from './insightsModel';
import { useLoseFiles, useWouldLose } from './useInsights';

const SEARCH_DELAY_MS = 300;

function ByBackup({ section }: { section: LoseSection }) {
  return (
    <Panel title="By backup" label="Files with no other checked copy, by backup">
      <ul className="lose-rows">
        {section.byBackup.map((b) => (
          <li key={b.backupId ?? 'none'} className="lose-row">
            <b className="lose-row__name">{b.name}</b>
            <span className="cell-sub">{countLine(b.files, b.bytes)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ByKind({ section, onShow }: { section: LoseSection; onShow: (kind: string) => void }) {
  return (
    <Panel title="By kind of file" label="Files with no other checked copy, by kind">
      <ul className="lose-rows">
        {section.kinds.map((k: LoseKind) => (
          <li key={k.kind} className="lose-row lose-row--kind">
            <b className="lose-row__name">{kindLabel(k.kind)}</b>
            <span className="cell-sub">{countLine(k.files, k.bytes)}</span>
            <Button variant="quiet" size="sm" onClick={() => onShow(k.kind)}>
              Show these files
            </Button>
            <ul className="lose-folders">
              {k.folders.map((f) => (
                <li key={f.folder} className="cell-sub">
                  {folderLine(f)}
                </li>
              ))}
              {k.rest.folders > 0 ? <li className="cell-sub">{`and ${k.rest.folders} more ${k.rest.folders === 1 ? 'folder' : 'folders'}: ${countLine(k.rest.files, k.rest.bytes)}`}</li> : null}
            </ul>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** The list of files, biggest first, with a search box and a kind filter. */
function Files({ placeId, part, kinds, kind, onKind }: { placeId: string; part: LosePart; kinds: readonly LoseKind[]; kind: string | null; onKind: (kind: string | null) => void }) {
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(text), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  const list = useLoseFiles({ placeId, part, search, kind });
  return (
    <Panel title="The files, biggest first" label="The files with no other checked copy">
      <div className="lose-tools">
        <TextField label="Search the names" value={text} onChange={setText} maxLength={200} />
        <label className="lose-kind">
          <span className="fbar__label">Kind</span>
          <select className="fsmall" value={kind ?? ''} onChange={(event) => onKind(event.target.value === '' ? null : event.target.value)}>
            <option value="">All kinds</option>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {kindLabel(k.kind)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.message ? (
        <p className="tone-text tone-text--warn" role="status">
          {list.message}
        </p>
      ) : list.loading && list.files.length === 0 ? (
        <Skeleton what="Finding the files" rows={3} />
      ) : list.files.length === 0 ? (
        <p className="row-list__empty" role="status">
          {search.trim() === '' && kind === null ? 'No files here.' : 'No file matches.'}
        </p>
      ) : (
        <ul className="lose-files" aria-label="Files">
          {list.files.map((f) => (
            <li key={f.path} className="lose-file">
              <span className="lose-file__path" title={f.path}>
                {f.path}
              </span>
              <span className="cell-sub">{kindLabel(f.kind)}</span>
              <span className="lose-file__size">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {list.more ? (
        <span>
          <Button variant="secondary" size="sm" disabled={list.loading} onClick={list.loadMore}>
            {list.loading ? 'Loading…' : 'Show more'}
          </Button>
        </span>
      ) : null}
    </Panel>
  );
}

/** The answer, once counted: the headline, the two parts, by backup, by kind, and the files. */
export function LoseAnswer({ placeId, label, detail }: { placeId: string; label: string; detail: WouldLoseDetail }) {
  const [chosen, setChosen] = useState<LosePart | null>(null);
  const [kind, setKind] = useState<{ part: LosePart; kind: string | null } | null>(null);
  // Opens on "Only here"; when that is empty and there are maybes, on those.
  const part: LosePart = chosen ?? (detail.onlyHere.files === 0 && detail.maybeCopied.files > 0 ? 'maybeCopied' : 'onlyHere');
  const kindNow = kind?.part === part ? kind.kind : null;
  const section = part === 'onlyHere' ? detail.onlyHere : detail.maybeCopied;
  const headline = loseHeadline(label, detail);
  return (
    <>
      <Panel label="The answer" accent="drive">
        <p className={`lose-headline tone-text tone-text--${headline.tone}`}>{headline.title}</p>
        <p className="cell-sub">{headline.sub}</p>
        <div className="lose-tiles">
          <StatTile label={PART_WORDS.onlyHere} value={countLine(detail.onlyHere.files, detail.onlyHere.bytes)} tone={detail.onlyHere.files > 0 ? 'crit' : 'ok'} detail="Nothing like it anywhere else" />
          <StatTile label={PART_WORDS.maybeCopied} value={countLine(detail.maybeCopied.files, detail.maybeCopied.bytes)} tone={detail.maybeCopied.files > 0 ? 'amber' : 'ok'} detail="Same name and size elsewhere" />
          <StatTile label="Not checked yet" value={countLine(detail.notChecked.files, detail.notChecked.bytes)} tone="neutral" detail="A copy may exist that cannot be seen" />
        </div>
      </Panel>
      {detail.onlyHere.files + detail.maybeCopied.files > 0 ? (
        <>
          <div className="lose-parts" role="group" aria-label="Which files">
            {(['onlyHere', 'maybeCopied'] as const).map((p) => (
              <Button key={p} variant={p === part ? 'primary' : 'secondary'} size="sm" aria-pressed={p === part} onClick={() => setChosen(p)} title={PART_HELP[p]}>
                {PART_WORDS[p]} ({(p === 'onlyHere' ? detail.onlyHere : detail.maybeCopied).files.toLocaleString('en-US')})
              </Button>
            ))}
          </div>
          {section.files === 0 ? (
            <p className="row-list__empty">Nothing in this part.</p>
          ) : (
            <>
              <ByBackup section={section} />
              <ByKind section={section} onShow={(k) => setKind({ part, kind: k })} />
              <Files key={part} placeId={placeId} part={part} kinds={section.kinds} kind={kindNow} onKind={(k) => setKind({ part, kind: k })} />
            </>
          )}
        </>
      ) : null}
    </>
  );
}

/**
 * "What would I lose if this died?" for one drive, phone, laptop or account: the files with no other CHECKED copy anywhere (the same checksum on
 * another device), by backup and by kind, biggest first, and the list with a search box. Read only: it never copies, changes or deletes a file.
 * Opens at once with a placeholder; main counts off the window's thread.
 */
export function WouldLoseScreen({ placeId }: { placeId: string }) {
  const navigate = useNavigate();
  const { snapshot } = usePlaces();
  const places = snapshot?.places ?? [];
  const label = places.find((p) => p.id === placeId)?.label ?? 'this device';
  const choices = loseChoices(places);
  const view = useWouldLose(placeId);
  return (
    <>
      <PageHeader
        icon={SourcesIcon}
        cat="laptop"
        eyebrow="Devices"
        title="What would I lose?"
        subtitle={`If ${label} died today. This only looks: nothing is copied, changed or deleted.`}
        actions={
          <div className="lose-head-actions">
            {choices.length > 0 ? (
              <label className="lose-kind">
                <span className="fbar__label">Drive or account</span>
                <select className="fsmall" value={placeId} onChange={(event) => navigate('devices', loseSub(event.target.value))}>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button variant="secondary" onClick={() => navigate('devices', null)}>
              Back to Devices
            </Button>
          </div>
        }
      />
      <div className="lose">
        {view.state === 'loading' ? (
          <Skeleton what={`Counting the files on ${label} that have no other checked copy`} rows={3} />
        ) : view.state === 'failed' ? (
          <EmptyState title="Could not count">{view.message}</EmptyState>
        ) : (
          <LoseAnswer key={placeId} placeId={placeId} label={label} detail={view.detail} />
        )}
      </div>
    </>
  );
}
