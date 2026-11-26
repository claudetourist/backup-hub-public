import type { DataSpaceInfo } from '../../shared/dataSpace';
import { formatBytes } from '../lib/format';

/** The Home line about room on the data disk: nothing when there is plenty, a notice under 5 GB, urgent under 2 GB. */
export interface SpaceRow {
  severity: 'amber' | 'crit';
  title: string;
  detail: string;
}

export function spaceRow(info: DataSpaceInfo | null): SpaceRow | null {
  if (!info || info.message === null) return null;
  if (info.level === 'critical') {
    return { severity: 'crit', title: `Backup Hub is nearly out of room on ${info.disk}`, detail: info.message };
  }
  if (info.level === 'low') {
    return { severity: 'amber', title: `Room is getting short on ${info.disk}`, detail: info.message };
  }
  return null;
}

/** The facts shown in Settings > Data and backups. */
export interface SpaceFact {
  label: string;
  value: string;
  note?: string | undefined;
}

export function spaceFacts(info: DataSpaceInfo): SpaceFact[] {
  const free = info.freeBytes === null ? 'Windows did not say' : `${formatBytes(info.freeBytes)} free`;
  const facts: SpaceFact[] = [
    { label: 'Database', value: formatBytes(info.dbBytes), note: info.walBytes > 1_000_000 ? `plus ${formatBytes(info.walBytes)} of recent changes, folded in when the jobs finish` : undefined },
    { label: `Free space on ${info.disk}`, value: free, note: info.level === 'ok' ? undefined : 'Under 5 GB is a warning; under 2 GB heavy jobs and saved copies do not start.' },
  ];
  if (info.snapshotCount > 0) {
    facts.push({ label: 'Daily copies in the data folder', value: `${info.snapshotCount} (${formatBytes(info.snapshotsBytes)})`, note: 'Move old ones to a backup drive if room gets short.' });
  }
  return facts;
}
