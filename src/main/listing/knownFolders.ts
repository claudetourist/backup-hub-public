import { runPowerShell } from './powershell';

/** Names in HKCU\...\Explorer\User Shell Folders for the four folders the laptop lists by default. */
export const KNOWN_FOLDER_KEYS = [
  { key: 'Personal', label: 'Documents' },
  { key: 'Desktop', label: 'Desktop' },
  { key: 'My Pictures', label: 'Pictures' },
  { key: 'My Video', label: 'Videos' },
] as const;

export interface KnownFolder {
  label: string;
  path: string;
}

/** Replace %NAME% with the environment value (case-insensitive). Null when a variable is unknown. */
export function expandEnv(value: string, env: Record<string, string | undefined>): string | null {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  let unknown = false;
  const out = value.replace(/%([^%]+)%/g, (_match, name: string) => {
    const v = lower.get(name.toLowerCase());
    if (v === undefined) unknown = true;
    return v ?? '';
  });
  return unknown ? null : out;
}

/**
 * Parse the registry JSON (an object with the four values), expand environment variables and keep
 * only absolute paths. Values that cannot be expanded are left out. Throws when not JSON.
 */
export function parseKnownFolders(raw: string, env: Record<string, string | undefined>): KnownFolder[] {
  const t = raw.replace(/^\uFEFF/, '').trim();
  if (t === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    throw new Error('The known folders were not readable JSON');
  }
  const o: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (o === null || typeof o !== 'object') return [];
  const rec = o as Record<string, unknown>;
  const out: KnownFolder[] = [];
  for (const { key, label } of KNOWN_FOLDER_KEYS) {
    const value = rec[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const expanded = expandEnv(value.trim(), env);
    if (expanded && /^[A-Za-z]:\\/.test(expanded)) out.push({ label, path: expanded.replace(/[\\/]+$/, '') });
  }
  return out;
}

export const KNOWN_FOLDERS_COMMAND =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' | " +
  "Select-Object 'Personal', 'Desktop', 'My Pictures', 'My Video' | ConvertTo-Json -Compress";

export async function readKnownFolders(env: Record<string, string | undefined> = process.env): Promise<KnownFolder[]> {
  return parseKnownFolders(await runPowerShell(KNOWN_FOLDERS_COMMAND), env);
}
