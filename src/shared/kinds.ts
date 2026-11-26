/**
 * "Change the category of a file" (Files search): types and pure rules shared by main, preload and the screen.
 * Pure data and pure functions only.
 */
import { isFileKind, type FileKind } from './fileKinds';

/** The most files one request may name. */
export const KIND_MAX_TARGETS = 500;

/** A file whose category is changed. */
export interface KindTarget {
  type: 'file';
  fileId: number;
}

/** Change the kind of files: these files, and optionally the similar ones next to them. */
export interface KindChange {
  kind: FileKind;
  targets: KindTarget[];
  /** Also the files of the same ending (and name start) in the same folder as the first file. */
  similar: boolean;
}

export type KindChangeResult = { ok: true; message: string; files: number } | { ok: false; message: string };

/** What "similar files" means for one file, before the person decides. */
export interface SimilarFiles {
  /** Other live files that would change as well (not counting the ones named). */
  count: number;
  /** "all .mp4 files starting with IMG_ in D:\Data\Trip", for the checkbox. */
  description: string;
}

/** The folder part of a stored path ("D:/MyData/a.jpg" gives "D:/MyData"). */
export function folderPartOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash < 0 ? '' : relPath.slice(0, slash);
}

export function nameOfPath(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

/** The letters at the start of a name before its first digit ("IMG_" for "IMG_20240101.mp4"); '' when it is too short to mean anything. */
export function namePrefix(name: string): string {
  const m = /^[^\d]{3,}/.exec(name.replace(/\.[^.]*$/, ''));
  return m ? m[0].toLowerCase() : '';
}

/** The ending of a file name in lower case without the dot; '' when it has none. */
export function endingOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function toTarget(value: unknown): KindTarget | null {
  if (value === null || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  return o['type'] === 'file' && typeof o['fileId'] === 'number' && Number.isSafeInteger(o['fileId']) && o['fileId'] > 0 ? { type: 'file', fileId: o['fileId'] } : null;
}

/** Checks anything the window sent as a change of kind. */
export function toKindChange(value: unknown): { ok: true; value: KindChange } | { ok: false; message: string } {
  if (value === null || typeof value !== 'object') return { ok: false, message: 'Something went wrong. Nothing was changed.' };
  const o = value as Record<string, unknown>;
  const list = o['targets'];
  const targets = Array.isArray(list) && list.length > 0 && list.length <= KIND_MAX_TARGETS ? list.map(toTarget) : null;
  if (!targets || !targets.every((t): t is KindTarget => t !== null) || !isFileKind(o['kind'])) return { ok: false, message: 'Please choose a kind. Nothing was changed.' };
  return { ok: true, value: { kind: o['kind'], targets, similar: o['similar'] === true } };
}
