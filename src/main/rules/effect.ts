/**
 * What a change to the person's choices would do to a plan that main holds (the line "This leaves out 1,234 files (2.1 GB) now and in
 * every later backup"). Pure and sliced (60,000 files must not freeze the window; see sliceWork.ts). Nothing is written.
 *
 * Every file of the plan is looked at twice, once with the choices as they are and once with the change made: a file that was going to be
 * copied and would now be left out is counted under "leaves out", a file that was left out and would now be offered under "brings back".
 * A file no choice names is judged by the built-in filter it was left out by (null: none).
 */
import type { FilesAndBytes } from '../../shared/rules';
import { STEP_ITEMS, type Steps } from '../sliceWork';
import { isLeftOut, type CompiledRules } from './ruleMatcher';

export interface EffectFile {
  path: string;
  size: number;
  /** The built-in filter that leaves this file out, or null when none does. */
  builtin: string | null;
}

export interface Effect {
  leavesOut: FilesAndBytes;
  bringsBack: FilesAndBytes;
}

export function* effectSteps(files: Iterable<EffectFile>, before: CompiledRules, after: CompiledRules): Steps<Effect> {
  const effect: Effect = { leavesOut: { files: 0, bytes: 0 }, bringsBack: { files: 0, bytes: 0 } };
  let n = 0;
  for (const f of files) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    const builtin = (): string | null => f.builtin;
    const was = isLeftOut(before.match(f.path), builtin);
    const will = isLeftOut(after.match(f.path), builtin);
    if (was === will) continue;
    const side = will ? effect.leavesOut : effect.bringsBack;
    side.files += 1;
    side.bytes += f.size;
  }
  return effect;
}
