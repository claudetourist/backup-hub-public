import { useCallback, useEffect, useState } from 'react';
import { DB_COPIES_WORDS } from '../../shared/appFolders';
import type { SavedCopiesOverview } from '../../shared/settings';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { formatBytes } from '../lib/format';
import { useSettings } from '../settings/SettingsProvider';

/** How many saved copies of each kind stay when old ones are removed. */
const KEEP_CHOICES: readonly number[] = [3, 5, 7, 10, 14, 30];

const when = (ms: number): string => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const kindLabel = (kind: 'settings' | 'database'): string => (kind === 'database' ? 'Database copy' : 'Settings file');

/**
 * The copies of Backup Hub's own data saved on each plugged-in backup drive: when, where, how big. From here the person can
 * test that a copy really opens (a scratch copy is checked; the drive is only read), choose how many to keep, and remove the
 * old ones. Nothing is removed without a click on "Yes, remove", and only Backup Hub's own saved files can ever be removed.
 */
export function SavedCopies({ refreshKey }: { refreshKey: number }) {
  const { settings, update } = useSettings();
  const [overview, setOverview] = useState<SavedCopiesOverview | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    window.backupHub.settings
      .savedCopies()
      .then((value) => {
        if (alive) setOverview(value);
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tick, refreshKey, settings.savedCopiesKeep]); // oxlint-disable-line react/exhaustive-effect-dependencies

  const remove = (placeId: string): void => {
    setConfirming(null);
    void (async () => {
      try {
        const result = await window.backupHub.settings.removeOldCopies(placeId, true);
        setMessage({ tone: result.ok ? 'ok' : 'warn', text: result.message });
      } catch {
        setMessage({ tone: 'warn', text: 'That did not work. Nothing was removed.' });
      }
      reload();
    })();
  };

  const test = (placeId: string, name: string): void => {
    setTesting(name);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.settings.testSavedCopy(placeId, name);
        setMessage({ tone: result.ok ? 'ok' : 'warn', text: `${name}: ${result.message}` });
      } catch {
        setMessage({ tone: 'warn', text: 'The test did not run. Nothing was changed.' });
      } finally {
        setTesting(null);
      }
    })();
  };

  const restore = (placeId: string, name: string): void => {
    setRestoring(null);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.settings.restoreFromDrive(placeId, name, true);
        setMessage({ tone: result.ok ? 'ok' : 'warn', text: result.message });
      } catch {
        setMessage({ tone: 'warn', text: 'That did not work. Nothing was changed.' });
      }
    })();
  };

  return (
    <div className="settings-stack">
      <b>Saved copies on your backup drives</b>
      {!overview || overview.drives.length === 0 ? <p className="cell-sub">Plug in a named backup drive to see its saved copies here.</p> : null}
      {overview?.drives.map((drive) => (
        <div key={drive.placeId} className="cell-stack cell-stack--tight">
          <span>
            <b>{drive.label}</b> <span className="cell-sub">· {drive.copies.length} {drive.copies.length === 1 ? 'copy' : 'copies'} in {DB_COPIES_WORDS}</span>
          </span>
          {drive.copies.length === 0 ? <span className="cell-sub">Nothing saved here yet. Press Save now.</span> : null}
          {drive.copies.length > 0 ? (
            <table className="data-table" aria-label={`Saved copies on ${drive.label}`}>
              <thead>
                <tr>
                  <th>Saved</th>
                  <th>What</th>
                  <th>Size</th>
                  <th>Check</th>
                </tr>
              </thead>
              <tbody>
                {drive.copies.map((copy) => (
                  <tr key={copy.name}>
                    <td>{when(copy.savedAt)}</td>
                    <td>{kindLabel(copy.kind)}</td>
                    <td>{formatBytes(copy.bytes)}</td>
                    <td>
                      <Button variant="quiet" size="sm" disabled={testing !== null} onClick={() => test(drive.placeId, copy.name)}>
                        {testing === copy.name ? 'Testing…' : 'Test restore'}
                      </Button>
                      {copy.kind === 'database' ? (
                        restoring === copy.name ? (
                          <span className="cell-stack cell-stack--tight">
                            <span className="cell-sub">Check this copy and get it ready? Nothing changes until Backup Hub is opened again, and what you have now is kept aside.</span>
                            <span className="settings-actions">
                              <Button variant="primary" size="sm" onClick={() => restore(drive.placeId, copy.name)}>
                                Yes, get it ready
                              </Button>
                              <Button variant="quiet" size="sm" onClick={() => setRestoring(null)}>
                                Not now
                              </Button>
                            </span>
                          </span>
                        ) : (
                          <Button variant="quiet" size="sm" disabled={testing !== null} onClick={() => setRestoring(copy.name)}>
                            Restore from this
                          </Button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {drive.exceeding > 0 ? (
            confirming === drive.placeId ? (
              <span className="cell-stack cell-stack--tight">
                <b>Remove {drive.exceeding} old {drive.exceeding === 1 ? 'copy' : 'copies'} from {drive.label}?</b>
                <span className="cell-sub">Only Backup Hub's own saved files older than the newest {overview.keep} of each kind. Nothing else on the drive is touched.</span>
                <span className="settings-actions">
                  <Button variant="primary" onClick={() => remove(drive.placeId)}>
                    Yes, remove
                  </Button>
                  <Button variant="quiet" onClick={() => setConfirming(null)}>
                    Keep them
                  </Button>
                </span>
              </span>
            ) : (
              <span className="settings-actions">
                <Button onClick={() => setConfirming(drive.placeId)}>Remove old copies ({drive.exceeding})</Button>
                <span className="cell-sub">Older than the newest {overview.keep} of each kind.</span>
              </span>
            )
          ) : null}
        </div>
      ))}
      <b id="keep-copies-title">Keep the newest</b>
      <div className="chips" role="group" aria-labelledby="keep-copies-title">
        {KEEP_CHOICES.map((n) => (
          <button key={n} type="button" className="chip" aria-pressed={settings.savedCopiesKeep === n} onClick={() => void update('savedCopiesKeep', n)}>
            {n}
          </button>
        ))}
      </div>
      <Toggle
        label="Remove older copies by itself"
        checked={settings.autoRemoveOldCopies}
        hint="Off by default. When on, each save deletes Backup Hub's own copies older than the newest ones above. Turn it on only if you are happy for it to delete without asking."
        onChange={(checked) => void update('autoRemoveOldCopies', checked)}
      />
      {message ? (
        <span className={`tone-text tone-text--${message.tone}`} role="status">
          {message.text}
        </span>
      ) : null}
    </div>
  );
}
