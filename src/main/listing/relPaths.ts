import path from 'node:path';
import { toSlashes } from './skipRules';

/**
 * How a path on this PC becomes the `rel_path` stored in the file list. Plain data (not a function) so it can be sent to a
 * worker thread: the laptop stores whole paths ("D:/MyData/a.jpg"), a named drive stores the path below its root.
 */
export type RelMode = { kind: 'absolute' } | { kind: 'under'; base: string };

export function relOfMode(mode: RelMode): (abs: string) => string {
  return mode.kind === 'absolute' ? (abs) => toSlashes(abs) : (abs) => toSlashes(path.relative(mode.base, abs));
}
