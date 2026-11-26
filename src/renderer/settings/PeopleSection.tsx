import { useCallback, useEffect, useMemo, useState } from 'react';
import { ownsLine, PERSON_PALETTE, removeBlockedMessage } from '../../shared/people';
import type { ProfileResult, ProfileView } from '../../shared/settings';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { backgroundColorRef } from '../components/sizing';
import { TextField } from '../components/TextField';
import { CheckIcon, UserIcon } from '../icons';
import { PROFILES_CHANGED_EVENT } from '../profiles/ProfileScopeProvider';

/** The first palette colour no one has yet (else the first). */
export function nextFreeColor(people: readonly Pick<ProfileView, 'color'>[]): string {
  const used = new Set(people.map((p) => p.color.toLowerCase()));
  return (PERSON_PALETTE.find((c) => !used.has(c.color)) ?? PERSON_PALETTE[0]!).color;
}

/**
 * Settings, People: the people of the household, each with a colour. Add (name and colour), Rename, Remove. A person who still has a
 * backup, a phone or a Google account cannot be removed: the screen says what they still have and nothing is changed. "You" stays.
 */
export function PeopleSection() {
  const [people, setPeople] = useState<readonly ProfileView[]>([]);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const color = picked ?? nextFreeColor(people);

  const apply = useCallback((result: ProfileResult): boolean => {
    if (result.ok) {
      setPeople(result.profiles);
      window.dispatchEvent(new Event(PROFILES_CHANGED_EVENT));
      setMessage(null);
      return true;
    }
    setMessage(result.message);
    return false;
  }, []);

  // Read the people on opening, and again when an owner changed somewhere else (the counts under each name).
  useEffect(() => {
    const read = (): void => {
      void (async () => {
        try {
          const result = await window.backupHub.profiles.list();
          if (result.ok) setPeople(result.profiles);
        } catch {
          setMessage('Could not load the people.');
        }
      })();
    };
    read();
    window.addEventListener(PROFILES_CHANGED_EVENT, read);
    return () => window.removeEventListener(PROFILES_CHANGED_EVENT, read);
  }, []);

  const run = async (action: () => Promise<ProfileResult>): Promise<boolean> => {
    setBusy(true);
    try {
      return apply(await action());
    } catch {
      setMessage('That did not work. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveRename = (id: number, value: string): void => {
    void (async () => {
      if (await run(() => window.backupHub.profiles.rename(id, value))) setRenaming(null);
    })();
  };
  const addPerson = (): void => {
    void (async () => {
      if (await run(() => window.backupHub.profiles.create(newName, color))) {
        setNewName('');
        setPicked(null);
      }
    })();
  };
  const startRemove = (person: ProfileView): void => {
    // The reason is shown at once, without asking main: a person who still has things cannot be removed.
    const blocked = removeBlockedMessage(person.name, person);
    if (blocked !== null) {
      setConfirming(null);
      setMessage(blocked);
      return;
    }
    setMessage(null);
    setConfirming(person.id);
  };
  const swatches = useMemo(() => PERSON_PALETTE, []);

  return (
    <Panel title="People" accent="person" icon={UserIcon} headerAside="One household, managed by you">
      <div className="settings-stack">
        <ul className="row-list" aria-label="People">
          {people.map((person) => (
            <li key={person.id} className="row-list__item profile-row">
              <span className="row-list__top">
                <span className="cell-stack">
                  <b>
                    <span className="profile-dot" ref={backgroundColorRef(person.color)} aria-hidden="true" />
                    {person.name}
                  </b>
                  <span className="cell-sub">{ownsLine(person)}</span>
                </span>
                {renaming?.id === person.id || confirming === person.id ? null : (
                  <span className="settings-actions">
                    <Button variant="quiet" size="sm" disabled={busy} onClick={() => setRenaming({ id: person.id, value: person.name })}>
                      Rename
                    </Button>
                    {person.isFirst ? null : (
                      <Button variant="quiet" size="sm" disabled={busy} onClick={() => startRemove(person)}>
                        Remove
                      </Button>
                    )}
                  </span>
                )}
              </span>
              {renaming?.id === person.id ? (
                <span className="inline-edit">
                  <TextField
                    label={`New name for ${person.name}`}
                    value={renaming.value}
                    onChange={(value) => setRenaming({ id: person.id, value })}
                    maxLength={60}
                    autoFocus
                    onEnter={() => saveRename(person.id, renaming.value)}
                  />
                  <span className="inline-edit__buttons">
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => saveRename(person.id, renaming.value)}>
                      Save name
                    </Button>
                    <Button size="sm" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </span>
                </span>
              ) : null}
              {confirming === person.id ? (
                <div className="confirm-box" role="group" aria-label={`Remove ${person.name}?`}>
                  <p>
                    <b>Remove {person.name}?</b> Their name goes from the list. Files and backups are not touched.
                  </p>
                  <span className="inline-edit__buttons">
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(() => window.backupHub.profiles.delete(person.id, true)).then(() => setConfirming(null))}>
                      Yes, remove {person.name}
                    </Button>
                    <Button size="sm" onClick={() => setConfirming(null)}>
                      Keep them
                    </Button>
                  </span>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="settings-block">
          <TextField label="Add a person" value={newName} onChange={setNewName} maxLength={60} hint="For example Mom or Sam." onEnter={addPerson} />
          <fieldset className="color-swatches">
            <legend className="field__label">Colour</legend>
            <span className="color-swatches__row">
              {swatches.map((c) => (
                <button key={c.color} type="button" className="color-swatch" aria-label={c.name} aria-pressed={color === c.color} title={c.name} ref={backgroundColorRef(c.color)} onClick={() => setPicked(c.color)}>
                  {color === c.color ? <CheckIcon size={14} /> : null}
                </button>
              ))}
            </span>
          </fieldset>
          <span className="settings-actions">
            <Button disabled={busy || newName.trim() === ''} onClick={addPerson}>
              Add person
            </Button>
          </span>
        </div>
        {message ? (
          <span className="tone-text tone-text--warn" role="alert">
            {message}
          </span>
        ) : null}
      </div>
    </Panel>
  );
}
