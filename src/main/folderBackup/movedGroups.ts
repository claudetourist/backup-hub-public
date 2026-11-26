/**
 * Files renamed or moved since they were backed up, told one line per folder (R1.6, PLAN 3c rule 3): "Folder renamed: Trip > Goa 2026 (1,204 files): nothing to copy",
 * not 1,204 new files. Pure; a generator, so 100,000 moved files never block the window.
 */
import { MAX_MOVED_GROUPS, type MovedGroup } from '../../shared/folderBackup';
import { STEP_ITEMS, type Steps } from '../sliceWork';
import { nameKey } from './folderPaths';

/** One file: the path below the backed-up folder where its backed-up copy has it, and where it is now. */
export interface Move {
  from: string;
  to: string;
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((s, i) => nameKey(s) === nameKey(b[i]!));

/**
 * The common ending (same file name, same sub-folders below) is cut off; what is left on each side is the folder that was renamed or moved. A file whose
 * own name changed has no common ending: it is counted with the files renamed on their own. The same folder pair is one group, whatever is below it.
 */
export function* groupMovesSteps(moves: readonly Move[]): Steps<{ groups: MovedGroup[]; files: number }> {
  const folders = new Map<string, MovedGroup>();
  let alone = 0;
  let n = 0;
  for (const m of moves) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    const a = m.from.split('/');
    const b = m.to.split('/');
    let i = a.length;
    let j = b.length;
    while (i > 0 && j > 0 && nameKey(a[i - 1]!) === nameKey(b[j - 1]!)) {
      i -= 1;
      j -= 1;
    }
    if (i === a.length || (i === 0 && j === 0)) {
      alone += 1;
      continue;
    }
    // "Docs" moved into "Archive" is Docs > Archive\\Docs, not (main folder) > Archive: keep the last folder they have in common.
    if ((i === 0 || j === 0) && a.length - i > 1) {
      i += 1;
      j += 1;
    }
    const from = a.slice(0, i);
    const to = b.slice(0, j);
    const key = `${from.join('/')}\t${to.join('/')}`;
    const have = folders.get(key);
    if (have) {
      have.files += 1;
      continue;
    }
    // A folder renamed stays where it was: the same folder above it. Anything else is a folder moved.
    const renamed = from.length > 0 && to.length > 0 && same(from.slice(0, -1), to.slice(0, -1));
    folders.set(key, { kind: renamed ? 'folder_renamed' : 'folder_moved', from: from.join('/'), to: to.join('/'), files: 1 });
  }
  const groups = [...folders.values()].toSorted((x, y) => y.files - x.files || (x.from < y.from ? -1 : x.from > y.from ? 1 : 0));
  const shown = groups.slice(0, MAX_MOVED_GROUPS);
  const files = groups.reduce((s, g) => s + g.files, 0) + alone;
  if (alone > 0) shown.push({ kind: 'files', from: '', to: '', files: alone });
  return { groups: shown, files };
}
