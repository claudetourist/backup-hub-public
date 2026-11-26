import { useState } from 'react';
import type { CreatePhoneBackupRequest, NewBackupChoices } from '../../shared/phoneBackup';
import type { ProfileView } from '../../shared/settings';
import { Button } from '../components/Button';
import { Drawer } from '../components/Drawer';
import { TextField } from '../components/TextField';
import { NEW_BACKUP_NAME_MAX } from '../../shared/newPhoneBackup';
import { EXISTING_FOLDER_CHOICE, EXISTING_FOLDER_NOTE, NO_DRIVE_LINE, NO_EXISTING_FOLDERS, createRequest, datedFolderExample, driveOf, formProblem, initialForm, newFolderChoiceText, pickDrive, type NewBackupForm } from './backupsModel';

const NO_PEOPLE: readonly Pick<ProfileView, 'id' | 'name' | 'color'>[] = [];

type Choices = Extract<NewBackupChoices, { ok: true }>;

interface DrawerProps {
  phoneName: string;
  choices: Choices;
  /** Saving is under way. */
  busy: boolean;
  /** What main said when it refused (shown in the form; nothing was changed). */
  error: string | null;
  onSave: (request: Omit<CreatePhoneBackupRequest, 'serial'>) => void;
  onCancel: () => void;
  /** The people to choose from ("Whose phone is this?"). Empty = the question is not asked. */
  people?: readonly Pick<ProfileView, 'id' | 'name' | 'color'>[];
  /** The person in focus: ticked to begin with (else the first person). */
  defaultOwnerId?: number | null;
  /** Tests give a fixed date. */
  today?: Date;
}

/** The form that makes a new backup for a phone plugged in: name, drive, folder. Nothing is made until Save is pressed. */
export function NewPhoneBackupDrawer({ phoneName, choices, busy, error, onSave, onCancel, today, people = NO_PEOPLE, defaultOwnerId = null }: DrawerProps) {
  const [form, setForm] = useState<NewBackupForm>(() => initialForm(choices, people.length === 0 ? null : (people.find((p) => p.id === defaultOwnerId)?.id ?? people[0]!.id)));
  const [opened] = useState(() => today ?? new Date());
  const drive = driveOf(choices, form.placeId);
  const problem = formProblem(form);
  const hasDrive = choices.drives.length > 0;
  const save = (): void => {
    const request = createRequest(form);
    if (request) onSave(request);
  };
  return (
    <Drawer
      title="Make a new backup"
      subtitle={'For ' + phoneName}
      onClose={onCancel}
      footer={
        <span className="settings-actions">
          {hasDrive ? (
            <Button variant="primary" disabled={busy || problem !== null} onClick={save}>
              Save
            </Button>
          ) : null}
          <Button variant="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </span>
      }
    >
      <div className="settings-stack">
        <TextField label="Name" value={form.name} maxLength={NEW_BACKUP_NAME_MAX} onChange={(name) => setForm({ ...form, name })} />
        {people.length > 0 ? (
          <fieldset className="settings-stack">
            <legend className="field__label">Whose phone is this?</legend>
            {people.map((p) => (
              <label key={p.id}>
                <input type="radio" name="new-backup-owner" checked={form.ownerId === p.id} onChange={() => setForm({ ...form, ownerId: p.id })} /> {p.name}
              </label>
            ))}
            <label>
              <input type="radio" name="new-backup-owner" checked={form.ownerId === 'new'} onChange={() => setForm({ ...form, ownerId: 'new' })} /> Someone new…
            </label>
            {form.ownerId === 'new' ? <TextField label="Their name" value={form.newPersonName} maxLength={60} autoFocus onChange={(newPersonName) => setForm({ ...form, newPersonName })} /> : null}
          </fieldset>
        ) : null}
        {hasDrive ? (
          <>
            <fieldset className="settings-stack">
              <legend className="field__label">Drive</legend>
              {choices.drives.map((d) => (
                <label key={d.placeId}>
                  <input type="radio" name="new-backup-drive" checked={form.placeId === d.placeId} onChange={() => setForm(pickDrive(form, choices, d.placeId))} /> {d.label}
                </label>
              ))}
            </fieldset>
            {drive ? (
              <fieldset className="settings-stack">
                <legend className="field__label">{'Folder on ' + drive.label}</legend>
                <label>
                  <input type="radio" name="new-backup-folder" checked={form.folderKind === 'new'} onChange={() => setForm({ ...form, folderKind: 'new' })} /> {newFolderChoiceText(form.name)}
                </label>
                <label>
                  <input type="radio" name="new-backup-folder" checked={form.folderKind === 'existing'} onChange={() => setForm({ ...form, folderKind: 'existing' })} /> {EXISTING_FOLDER_CHOICE}
                </label>
                {form.folderKind === 'existing' ? (
                  drive.folders.length === 0 ? (
                    <span className="cell-sub">{NO_EXISTING_FOLDERS}</span>
                  ) : (
                    <>
                      <select className="fsmall" aria-label="Folders already on the drive" value={form.existingName ?? ''} onChange={(event) => setForm({ ...form, existingName: event.target.value === '' ? null : event.target.value })}>
                        <option value="">Choose a folder</option>
                        {drive.folders.map((folder) => (
                          <option key={folder} value={folder}>
                            {folder}
                          </option>
                        ))}
                      </select>
                      <span className="cell-sub">{EXISTING_FOLDER_NOTE}</span>
                    </>
                  )
                ) : null}
                <span className="cell-sub">{datedFolderExample(form.name, opened)}</span>
              </fieldset>
            ) : null}
          </>
        ) : (
          <span role="status" className="cell-sub">
            {NO_DRIVE_LINE}
          </span>
        )}
        {error ? (
          <span role="alert" className="cell-sub">
            {error}
          </span>
        ) : null}
      </div>
    </Drawer>
  );
}
