import { memo, useMemo, useState } from 'react';
import type { RemovedBackup } from '../../shared/backups';
import { OwnerChip } from '../components/OwnerChip';
import { BackupKindChip } from '../components/BackupKindChip';
import { BACKUP_KIND_CATEGORY } from '../components/backupKinds';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { ProgressBar } from '../components/ProgressBar';
import { StatusPill } from '../components/StatusPill';
import { TextField } from '../components/TextField';
import { CopyIcon } from '../icons';
import { useToast } from '../components/Toast';
import { scopeLabel } from '../profiles/profileScope';
import { useOwnerActions } from '../profiles/useOwnerActions';
import { MAKE_NEW_BACKUP_TEXT } from './backupsModel';
import { buildEntries, bulkActions, countLine, filterEntries, LIST_SORTS, NO_MATCH, sortEntries, type BackupEntry, type BackupTab, type ListSort } from './backupListModel';
import { HistoryBringIn } from './HistoryBringIn';
import { KeepNotesCard } from './KeepNotesCard';
import { MirrorCheckPanel } from './MirrorCheckPanel';
import { MirrorPanel } from './MirrorPanel';
import { NewPhoneBackupDrawer } from './NewPhoneBackupDrawer';
import { NewPhoneCard } from './NewPhoneCard';
import { useNewPhoneFlow } from './useNewPhoneFlow';
import type { BackupsData } from './useBackupsData';

interface RowProps {
  entry: BackupEntry;
  people: BackupsData['profiles'];
  onOpen: (id: number, tab: BackupTab, go: boolean) => void;
  onOwner: (backupId: number, personId: number) => void;
}

/** One backup: the name first, then what it is of and where it is kept, the one status word, the last date, the size, a live line while a job runs, and one button. */
const Row = memo(function Row({ entry, people, onOpen, onOwner }: RowProps) {
  const { row } = entry;
  const stop = (event: { stopPropagation: () => void }): void => event.stopPropagation();
  return (
    <li className={`bk-row cat--${BACKUP_KIND_CATEGORY[entry.kind]}`} onClick={() => onOpen(row.id, 'overview', false)}>
      <span className="bk-row__main">
        <BackupKindChip kind={entry.kind} />
        <span className="bk-row__text">
          <span className="bk-row__title">
            <button type="button" className="bk-row__name" title={row.name} onClick={(event) => { stop(event); onOpen(row.id, 'overview', false); }}>
              {row.name}
            </button>
            <span onClick={stop}>
              <OwnerChip what={`the backup ${row.name}`} owner={people.find((p) => p.id === row.personId) ?? null} people={people} onChoose={(personId) => onOwner(row.id, personId)} />
            </span>
            {row.enabled ? null : <span className="cell-sub">Off</span>}
          </span>
          <span className="cell-sub bk-row__line" title={entry.source}>{entry.source}</span>
          <span className="cell-sub bk-row__line" title={entry.kept}>
            {entry.kept}
            {entry.note ? <span role="status"> · {entry.note}</span> : null}
          </span>
        </span>
      </span>
      <span className="bk-row__status">{entry.status ? <StatusPill status={entry.status} /> : <span className="cell-sub">Switched off</span>}</span>
      <span className="bk-row__facts">
        <span>{entry.last}</span>
        <span className="cell-sub">{entry.numbers}</span>
      </span>
      <span className="bk-row__action" onClick={stop}>
        <Button size="sm" variant={entry.action.primary ? 'primary' : 'secondary'} onClick={() => onOpen(row.id, entry.action.tab, entry.action.go)}>
          {entry.action.label}
        </Button>
      </span>
      {entry.progress ? (
        <span className="bk-row__progress" role="status">
          <span className="cell-sub">{entry.progress}</span>
          {entry.percent !== null ? <ProgressBar label={entry.progress} value={entry.percent} valueText={entry.progress} /> : <ProgressBar label={entry.progress} indeterminate />}
        </span>
      ) : null}
    </li>
  );
});

function RemovedList({ removed, onPutBack }: { removed: readonly RemovedBackup[]; onPutBack: (id: number) => void }) {
  return (
    <ul className="bk-removed" aria-label="Removed backups">
      {removed.map((r) => (
        <li key={r.id} className="bk-removed__row">
          <span className="bk-removed__name">
            <b>{r.name}</b>
            <span className="cell-sub"> {r.from}</span>
          </span>
          <Button size="sm" variant="secondary" onClick={() => onPutBack(r.id)}>
            Put back
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The list page (#/backups): one row for every backup of the person in focus, a search box and a sort, the actions that cover all backups in the
 * header, and the extras (a new phone, the old history, the Google Keep notes) below. Clicking a row opens that backup's page.
 */
export function BackupsList({ data, onOpen }: { data: BackupsData; onOpen: (id: number, tab: BackupTab, go: boolean) => void }) {
  const { rows, profiles, scope, mirror, sizes, jobs, connected, now, overview, loadError, removed } = data;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ListSort>('status');
  const [bulk, setBulk] = useState<null | 'mirror' | 'check'>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const toast = useToast();
  const { setBackupOwner } = useOwnerActions();
  const phones = useNewPhoneFlow(data);

  const ownerNames = useMemo(() => new Map(profiles.map((p) => [p.id, p.name] as const)), [profiles]);
  const entries = useMemo(() => (rows ? buildEntries(rows, { now, mirror, sizes, jobs, connected, ownerNames }) : []), [rows, now, mirror, sizes, jobs, connected, ownerNames]);
  const shown = useMemo(() => sortEntries(filterEntries(entries, query), sort), [entries, query, sort]);
  const actions = useMemo(() => bulkActions(rows ?? [], mirror), [rows, mirror]);
  const secondRows = useMemo(() => (rows ?? []).filter((r) => (r.destinations?.length ?? 1) > 1), [rows]);
  const owner = (backupId: number, personId: number): void => void setBackupOwner(backupId, personId).then((ok) => (ok ? data.load() : undefined));
  const putBack = (id: number): void => {
    void (async () => {
      try {
        const result = await window.backupHub.backups.unarchive(id);
        toast.show({ tone: result.ok ? 'ok' : 'error', text: result.message });
      } catch {
        toast.show({ tone: 'error', text: 'That did not work. Nothing was changed.' });
      }
      data.load();
    })();
  };

  const headerActions = (
    <span className="settings-actions">
      {actions.mirror ? (
        <Button size="sm" variant="secondary" onClick={() => setBulk('mirror')}>
          {actions.mirror}
        </Button>
      ) : null}
      {actions.check ? (
        <Button size="sm" variant="secondary" onClick={() => setBulk('check')}>
          {actions.check}
        </Button>
      ) : null}
      {phones.putOff.length > 0 && phones.toAsk.length === 0 ? (
        <Button size="sm" variant="secondary" disabled={phones.busy} onClick={() => phones.openMakeNew(phones.putOff[0]!)}>
          {MAKE_NEW_BACKUP_TEXT}
        </Button>
      ) : null}
    </span>
  );

  return (
    <>
      <PageHeader icon={CopyIcon} cat="phone" eyebrow="What is saved where" title="Backups" subtitle={rows ? `${scopeLabel(scope, profiles)}: ${countLine(shown.length, entries.length)}` : 'Your backups, and when each one last ran.'} actions={headerActions} />
      <div className="devices">
        {loadError ? (
          <p role="alert" className="cell-sub">
            {loadError}
          </p>
        ) : null}
        {phones.message ? (
          <p role="status" className="cell-sub">
            {phones.message}
          </p>
        ) : null}
        {phones.toAsk.map((phone) => (
          <NewPhoneCard key={phone.serial} phone={phone} backups={connected?.backupsWithoutPhone ?? []} busy={phones.busy} onYes={(backupId) => phones.linkPhone(backupId, phone.serial)} onMakeNew={() => phones.openMakeNew(phone)} onNotNow={() => data.hidePhone(phone.serial)} />
        ))}
        {phones.making ? (
          <NewPhoneBackupDrawer
            phoneName={phones.making.phone.phoneName}
            choices={phones.making.choices}
            people={profiles}
            defaultOwnerId={scope === 'all' ? null : scope}
            busy={phones.busy}
            error={phones.makeError}
            onSave={(request) => phones.saveMakeNew(phones.making!.phone.serial, request, () => undefined)}
            onCancel={phones.closeForm}
          />
        ) : null}
        {bulk === 'mirror' ? (
          <div className="bk-bulk">
            <MirrorPanel rows={secondRows} status={mirror} now={now} onFinished={data.load} onShowCheck={() => setBulk('check')} autoStart="all" onClose={() => setBulk(null)} />
          </div>
        ) : null}
        {bulk === 'check' ? (
          <div className="bk-bulk">
            <MirrorCheckPanel rows={secondRows} status={mirror} onFinished={data.load} autoStart="all" onClose={() => setBulk(null)} />
          </div>
        ) : null}
        {overview && overview.backups.length === 0 ? (
          <EmptyState title="No backups yet">PhoneBackup kept a record of your old backups. Bring it in to see them here.</EmptyState>
        ) : null}
        {overview && overview.backups.length > 0 && rows !== null && rows.length === 0 ? (
          <EmptyState title={`${scopeLabel(scope, profiles)} has no backups yet`}>Switch the person at the top left to see the others, or give a backup to {scopeLabel(scope, profiles)} with the chip on its row.</EmptyState>
        ) : null}
        {rows !== null && rows.length > 0 ? (
          <section className="bk-list-wrap" aria-label="Your backups">
            <div className="bk-toolbar">
              <TextField label="Find a backup" value={query} onChange={setQuery} maxLength={200} searchBox />
              <label className="devices-accounts__sort">
                <span className="fbar__label">Sort by</span>
                <select className="fsmall" value={sort} onChange={(event) => setSort(event.target.value as ListSort)}>
                  {LIST_SORTS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {connected === null && data.lookingForPhones ? (
                <span className="cell-sub" role="status">
                  Looking for a plugged-in phone…
                </span>
              ) : (
                <Button size="sm" variant="quiet" onClick={data.checkPhones}>
                  Check for a phone
                </Button>
              )}
            </div>
            {shown.length === 0 ? (
              <p className="row-list__empty" role="status">
                {NO_MATCH(query)}
              </p>
            ) : (
              <ul className="bk-list">
                {shown.map((entry) => (
                  <Row key={entry.row.id} entry={entry} people={profiles} onOpen={onOpen} onOwner={owner} />
                ))}
              </ul>
            )}
          </section>
        ) : null}
        <KeepNotesCard cards={data.folderCards} onAdded={data.load} />
        <HistoryBringIn overview={overview} now={now} onDone={data.load} />
        {removed.length > 0 ? (
          <div className="settings-stack">
            <span>
              <Button size="sm" variant="quiet" aria-expanded={showRemoved} onClick={() => setShowRemoved(!showRemoved)}>
                {showRemoved ? 'Hide removed backups' : `Show removed backups (${removed.length})`}
              </Button>
            </span>
            {showRemoved ? <RemovedList removed={removed} onPutBack={putBack} /> : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
