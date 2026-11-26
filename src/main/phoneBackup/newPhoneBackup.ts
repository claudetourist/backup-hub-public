/**
 * "Make a new backup for this phone": a phone plugged in that belongs to no backup gets a backup of its own. The choices for the form are
 * read only. Creating changes the database only (one transaction): nothing is written to the drive, not even the folder; the first
 * backup run makes its dated folder as it always does. The drive is only read (is the folder there, is it a folder).
 */
import path from 'node:path';
import { APP_FOLDER, MY_DATA_FOLDER } from '../../shared/appFolders';
import { NEW_BACKUP_NAME_MAX, folderPrefixFor, folderRootOf, safeFolderName } from '../../shared/newPhoneBackup';
import type { PhoneDevice } from '../../shared/phone';
import type { CreatePhoneBackupRequest, CreatePhoneBackupResult, NewBackupChoices, NewBackupDrive } from '../../shared/phoneBackup';
import { checkLabel } from '../../shared/places';
import { cleanRoot, isUnder, pathKey } from '../backupProfiles/pathForms';
import type { BackupProfileStore } from '../backupProfiles/profileStore';
import { rawFs as fs } from '../rawFs';
import type { PhoneBackupDeps } from './phoneBackupTypes';

/** What the service gives this module (its own private parts). */
export interface NewBackupContext {
  deps: PhoneBackupDeps;
  store: BackupProfileStore;
  busy(): boolean;
  readDevices(): Promise<PhoneDevice[] | null>;
  writePlaceIdentity(placeId: string | null, phone: { serial: string; model: string }): void;
}

/** Thrown inside the transaction so that nothing stays half made. */
class Undo extends Error {}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const noChange = (message: string): { ok: false; message: string } => ({ ok: false, message: message + ' Nothing was changed.' });

type PhoneCheck = { ok: true; model: string } | { ok: false; message: string };

/** Rule 1: the phone is plugged in and allowed right now, belongs to no backup (switched on or off), and no phone backup is waiting or running. */
async function checkPhone(ctx: NewBackupContext, serial: unknown): Promise<PhoneCheck> {
  if (typeof serial !== 'string' || serial.trim() === '') return { ok: false, message: 'That is not a valid request.' };
  const devices = await ctx.readDevices();
  if (devices === null) return { ok: false, message: 'Backup Hub cannot find the program it needs to talk to a phone (adb).' };
  const device = devices.find((d) => d.serial === serial);
  if (!device) return { ok: false, message: 'That phone is not plugged in any more.' };
  if (device.state !== 'device') return { ok: false, message: 'Unlock the phone and tap Allow on its screen first.' };
  if (ctx.deps.db.prepare('SELECT 1 FROM backup_profiles WHERE phone_serial = ?').get(serial)) return { ok: false, message: 'That phone already has its own backup.' };
  if (ctx.busy()) return { ok: false, message: 'A phone backup is already waiting or running. Watch it in Activity.' };
  return { ok: true, model: device.model };
}

interface DriveNow {
  placeId: string;
  label: string;
  root: string;
}

/** Rule 3: the drives that are plugged in now and may hold a new backup (readable, no open question about the drive, not read-only). */
async function usableDrives(ctx: NewBackupContext): Promise<{ usable: DriveNow[]; refusals: Map<string, string> }> {
  const all = (await ctx.deps.connectedDrives?.()) ?? [];
  const usable: DriveNow[] = [];
  const refusals = new Map<string, string>();
  for (const d of all) {
    const why = d.unreadable
      ? `${d.label} is plugged in but cannot be read properly, so no backup can be set up on it.`
      : (d.blocked ?? ctx.deps.writeProtected?.(d.placeId) ?? null);
    if (why === null) usable.push({ placeId: d.placeId, label: d.label, root: d.root });
    else refusals.set(d.placeId, why);
  }
  return { usable, refusals };
}

interface Entry {
  name: string;
  isDirectory: boolean;
}

/**
 * What is directly in the MyData folder of the drive (read only). Null when the folder is not there or cannot be read. Asynchronous on purpose:
 * a drive that stops answering (the T7 does, on USB trouble) would freeze the whole window for as long as a synchronous read waits.
 */
async function readMyData(root: string): Promise<Entry[] | null> {
  try {
    return (await fs.promises.readdir(path.join(root, MY_DATA_FOLDER), { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return null;
  }
}

/** The backup folders already saved for this drive, for every backup (switched on or off). */
const savedRoots = (ctx: NewBackupContext, placeId: string): string[] => ctx.deps.db.prepare('SELECT root FROM backup_destinations WHERE place_id = ?').pluck().all(placeId) as string[];

/** True when the folder is the same as, inside, or around a folder another backup already uses on this drive. */
function overlaps(root: string, others: readonly string[]): boolean {
  const key = pathKey(root);
  return others.some((o) => isUnder(key, pathKey(o)) || isUnder(pathKey(o), key));
}

/** Rule 4 ("existing"): the folders directly in MyData that may be picked. */
function pickableFolders(entries: readonly Entry[], others: readonly string[]): string[] {
  return entries
    .filter((e) => e.isDirectory && !sameName(e.name, APP_FOLDER) && cleanRoot(folderRootOf(e.name)) !== null && !overlaps(folderRootOf(e.name), others))
    .map((e) => e.name)
    .toSorted((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/** What the form needs: the suggested name and the drives that may be picked, each with its pickable folders. Changes nothing. */
export async function newBackupChoices(ctx: NewBackupContext, serial: unknown): Promise<NewBackupChoices> {
  const phone = await checkPhone(ctx, serial);
  if (!phone.ok) return phone;
  const { usable } = await usableDrives(ctx);
  const drives: NewBackupDrive[] = await Promise.all(usable.map(async (d) => ({ placeId: d.placeId, label: d.label, folders: pickableFolders((await readMyData(d.root)) ?? [], savedRoots(ctx, d.placeId)) })));
  return { ok: true, suggestedName: Array.from(phone.model.trim()).slice(0, NEW_BACKUP_NAME_MAX).join(''), drives };
}

/** Makes the backup. Every refusal changes nothing; on success the phone shows with "Back up <name> now". */
export async function createForPhone(ctx: NewBackupContext, request: CreatePhoneBackupRequest, personId?: number): Promise<CreatePhoneBackupResult> {
  const { db } = ctx.deps;
  const asked = request as Partial<CreatePhoneBackupRequest> | null;
  const folderAsked = asked?.folder;
  if (!asked || typeof asked.placeId !== 'string' || asked.placeId === '' || !folderAsked || (folderAsked.kind !== 'new' && folderAsked.kind !== 'existing')) return noChange('That is not a valid request.');

  // 1. The phone.
  const phone = await checkPhone(ctx, asked.serial);
  if (!phone.ok) return noChange(phone.message);
  const serial = asked.serial as string;

  // 2. The name.
  const checked = checkLabel(asked.name, 'name');
  if (!checked.ok) return noChange(checked.message);
  const name = checked.value;
  if (Array.from(name).length > NEW_BACKUP_NAME_MAX) return noChange(`Keep the name under ${NEW_BACKUP_NAME_MAX + 1} characters.`);
  if (db.prepare('SELECT 1 FROM backup_profiles WHERE name = ? COLLATE NOCASE').get(name)) return noChange(`There is already a backup called ${name}.`);

  // 3. The drive.
  const { usable, refusals } = await usableDrives(ctx);
  const drive = usable.find((d) => d.placeId === asked.placeId);
  if (!drive) return noChange(refusals.get(asked.placeId) ?? 'That drive is not plugged in right now.');

  // 4. The folder (only read: is it there, is it a folder).
  const entries = await readMyData(drive.root);
  const others = savedRoots(ctx, drive.placeId);
  let folder: string;
  if (folderAsked.kind === 'new') {
    const safe = safeFolderName(name);
    if (safe === null) return noChange('That name cannot be used as a folder name. Use letters or numbers in it.');
    if (sameName(safe, APP_FOLDER)) return noChange('That folder is kept for Backup Hub itself. Choose another name.');
    if (entries?.some((e) => sameName(e.name, safe))) return noChange(`A folder called ${safe} is already on ${drive.label}. Choose "A folder already on the drive" to use it.`);
    folder = safe;
  } else {
    const found = typeof folderAsked.name === 'string' ? entries?.find((e) => sameName(e.name, folderAsked.name)) : undefined;
    if (!found) return noChange(`There is no folder called ${String(folderAsked.name)} in ${MY_DATA_FOLDER} on ${drive.label}.`);
    if (!found.isDirectory) return noChange(`${found.name} is not a folder.`);
    if (sameName(found.name, APP_FOLDER)) return noChange('That folder is kept for Backup Hub itself. Choose another folder.');
    folder = found.name;
  }
  const root = folderRootOf(folder);
  if (cleanRoot(root) === null) return noChange('That folder name cannot be used.');
  if (overlaps(root, others)) return noChange('Another backup already saves to that folder, or to a folder inside it or around it. Choose another folder.');

  // Everything is checked: one transaction, database only.
  try {
    return db.transaction((): CreatePhoneBackupResult => {
      if (db.prepare('SELECT 1 FROM backup_profiles WHERE phone_serial = ?').get(serial)) throw new Undo('That phone already has its own backup.');
      const made = ctx.store.create({ ...(personId !== undefined ? { personId } : {}), name, sourceKind: 'phone', phoneSerial: serial, folderPrefix: folderPrefixFor(name), enabled: true, importKey: null });
      if (!made.ok) throw new Undo(made.message);
      const placeId = ctx.store.ensurePhonePlace(made.id);
      ctx.writePlaceIdentity(placeId, { serial, model: phone.model });
      const saved = ctx.store.addDestination({ profileId: made.id, placeId: drive.placeId, root, role: 'primary' });
      if (!saved.ok) throw new Undo(saved.message);
      ctx.deps.log.info(`phoneBackup: made backup ${made.id} for a new phone (${phone.model})`);
      return { ok: true, backupId: made.id, message: `${name} is set up. Its backups go to ${drive.label}\\${MY_DATA_FOLDER}\\${folder}.` };
    })();
  } catch (error) {
    if (error instanceof Undo) return noChange(error.message);
    throw error;
  }
}
