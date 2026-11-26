import { BackupKindChip } from '../components/BackupKindChip';
import { BACKUP_KIND_CATEGORY } from '../components/backupKinds';
import { Button } from '../components/Button';
import { StatusPill } from '../components/StatusPill';
import type { HomeBackup } from './homeModel';

/**
 * Home's "Your backups": one row per backup that is on, with the one status word, the last date and, for a phone, either
 * "Back up now" (it is plugged in) or what to do (plug it in). `items` is null until the list has been read.
 */
export function YourBackups({ items, failed, onBackUp }: { items: readonly HomeBackup[] | null; failed: boolean; onBackUp: (backupId: number) => void }) {
  return (
    <section className="home-section" aria-label="Your backups">
      <h2 className="devices-section__title">Your backups</h2>
      {failed ? (
        <p className="cell-sub" role="status">
          The list of backups could not be read.
        </p>
      ) : items === null ? null : items.length === 0 ? (
        <p className="cell-sub">No backup is set up yet.</p>
      ) : (
        <ul className="home-backups">
          {items.map((item) => (
            <li key={item.id} className={`home-backup cat--${BACKUP_KIND_CATEGORY[item.kind]}`}>
              <span className="home-backup__who">
                <BackupKindChip kind={item.kind} />
                <b className="home-backup__name" title={item.name}>
                  {item.name}
                </b>
              </span>
              <StatusPill status={item.status} />
              <span className="cell-sub home-backup__when">
                {item.lastLine}
                {item.mirrorLine ? <><br />{item.mirrorLine}</> : null}
                {item.mirrorNote ? <><br />{item.mirrorNote}</> : null}
              </span>
              <span className="home-backup__action">
                {item.canBackUpNow ? (
                  <Button size="sm" variant="secondary" onClick={() => onBackUp(item.id)}>
                    Back up now
                  </Button>
                ) : item.plugNote ? (
                  <span className="cell-sub">{item.plugNote}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
