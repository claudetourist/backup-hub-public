import { runPowerShell } from './powershell';

/** A OneDrive Personal account found on this PC. */
export interface OneDriveAccount {
  /** The account id Microsoft uses; the key for the place. Null when only the environment variable was found. */
  cid: string | null;
  /** Where the OneDrive folder is on this PC right now (never remembered as identity: it can move). */
  userFolder: string;
  email: string | null;
}

/** The three values read from HKCU\Software\Microsoft\OneDrive\Accounts\Personal. */
export interface OneDriveRegistry {
  UserFolder?: unknown;
  cid?: unknown;
  UserEmail?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Parse the JSON of the registry query. PowerShell prints nothing when the key is absent, and a
 * bare object when it exists. Throws when the text is not JSON at all.
 */
export function parseOneDriveRegistry(raw: string): OneDriveRegistry | null {
  const t = raw.replace(/^\uFEFF/, '').trim();
  if (t === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    throw new Error('The OneDrive settings were not readable JSON');
  }
  const first: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  return first !== null && typeof first === 'object' && !Array.isArray(first) ? first : null;
}

/** Read-only registry query. */
export const ONEDRIVE_COMMAND =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\OneDrive\\Accounts\\Personal' -ErrorAction SilentlyContinue | " +
  'Select-Object UserFolder, cid, UserEmail | ConvertTo-Json -Compress';

export async function readOneDriveRegistry(): Promise<OneDriveRegistry | null> {
  return parseOneDriveRegistry(await runPowerShell(ONEDRIVE_COMMAND));
}

export interface DetectOneDriveDeps {
  /** Reads the registry (null = key absent). Defaults to the real query; tests pass fakes. */
  readRegistry?: () => Promise<OneDriveRegistry | null>;
  env?: Record<string, string | undefined>;
  /** Defaults to true for every path; used to ignore a stale registry value. */
  folderExists?: (folder: string) => boolean;
}

/**
 * Find the OneDrive Personal account: the registry first (UserFolder, cid, UserEmail), then the
 * `OneDriveConsumer` environment variable. Null when OneDrive is absent. Nothing is written.
 */
export async function detectOneDrive(deps: DetectOneDriveDeps = {}): Promise<OneDriveAccount | null> {
  const read = deps.readRegistry ?? readOneDriveRegistry;
  const env = deps.env ?? process.env;
  let registry: OneDriveRegistry | null = null;
  try {
    registry = await read();
  } catch {
    registry = null;
  }
  const folder = text(registry?.UserFolder);
  if (folder && (deps.folderExists?.(folder) ?? true)) {
    return { cid: text(registry?.cid), userFolder: folder, email: text(registry?.UserEmail) };
  }
  const fromEnv = text(env['OneDriveConsumer']);
  if (fromEnv) return { cid: text(registry?.cid), userFolder: fromEnv, email: text(registry?.UserEmail) };
  return null;
}

/** Every OneDrive folder this PC has (Personal, work, and the generic variable), for "never descend into OneDrive". */
export function oneDriveEnvFolders(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  for (const name of ['OneDriveConsumer', 'OneDriveCommercial', 'OneDrive']) {
    const v = text(env[name]);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
