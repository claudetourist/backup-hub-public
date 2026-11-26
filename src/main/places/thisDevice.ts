import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkLabel } from '../../shared/places';
import { parseJsonLoose, writeFileAtomic } from '../fsutil';
import { UUID_PATTERN } from './driveCard';
import { ownMove } from '../danger/ownFiles';

export const THIS_DEVICE_FILE = 'this-device.json';

/** Which laptop this data folder belongs to. Survives renames; the id never changes. */
export interface ThisDevice {
  id: string;
  label: string;
  /** ISO 8601 */
  createdAt: string;
}

export function thisDevicePath(dataDir: string): string {
  return path.join(dataDir, THIS_DEVICE_FILE);
}

function parseDevice(text: string): ThisDevice | null {
  try {
    const o = parseJsonLoose(text) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return null;
    if (typeof o['id'] !== 'string' || !UUID_PATTERN.test(o['id'])) return null;
    const label = checkLabel(o['label']);
    if (!label.ok) return null;
    return {
      id: o['id'].toLowerCase(),
      label: label.value,
      createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'] : '',
    };
  } catch {
    return null;
  }
}

function defaultLabel(hostname: string): string {
  const checked = checkLabel(hostname);
  return checked.ok ? checked.value : 'This laptop';
}

/**
 * Read `this-device.json`, or create it (new uuid, label = hostname). A file that exists but is
 * unreadable is moved aside (never deleted) before a new one is made.
 */
export function loadThisDevice(dataDir: string, hostname: string, now: Date = new Date()): ThisDevice {
  const file = thisDevicePath(dataDir);
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (text !== null) {
    const parsed = parseDevice(text);
    if (parsed) return parsed;
    ownMove(file, `${file}.unreadable-${now.getTime()}`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const device: ThisDevice = { id: randomUUID(), label: defaultLabel(hostname), createdAt: now.toISOString() };
  writeFileAtomic(file, `${JSON.stringify(device, null, 2)}\n`);
  return device;
}

/** Change the laptop's display label (the id stays). */
export function saveThisDeviceLabel(dataDir: string, device: ThisDevice, label: string): ThisDevice {
  const next: ThisDevice = { ...device, label };
  writeFileAtomic(thisDevicePath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
