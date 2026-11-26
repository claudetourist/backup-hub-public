/**
 * "A look counts only if it finished without error" (PLAN.md section 3c rule 1) and "when unsure, change nothing and ask" (rule 5).
 * Turns a phone look plus its compare into either something that may be recorded, or a "Needs your decision" object that changes
 * nothing. Pure. There is no screen for the object yet; it carries plain words and the options the person will have.
 */
import type { PhoneLook } from '../adb/phoneLook';
import { finishSync, type Steps } from '../sliceWork';
import { compareLookSteps, type CompareInput, type CompareResult } from './compare';

export interface LookPolicy {
  /** More than this share of the known files gone or changed since last time is a "looks wrong" look (3c rule 1: 30%, a setting). */
  massChangePercent: number;
  /** The percentage rule needs at least this many known files (a phone with 3 files losing 1 is not a mass change). */
  massChangeMinFiles: number;
}

export const DEFAULT_LOOK_POLICY: LookPolicy = { massChangePercent: 30, massChangeMinFiles: 10 };

export type DecisionKind = 'look_incomplete' | 'look_empty' | 'look_mass_change' | 'look_name_clash';
export type DecisionOption = 'try_again' | 'accept';

export interface NeedsDecision {
  kind: DecisionKind;
  title: string;
  /** Plain words for the person: what was seen and that nothing was changed. */
  plain: string;
  /** The technical reasons, for the "Why?" line. */
  reasons: string[];
  numbers: { listed: number; known: number; gone: number; changed: number };
  /** What the person can do. A half list can only be tried again: accepting it would record names that may be cut short. */
  options: DecisionOption[];
}

export type LookOutcome =
  | { ok: true; compare: CompareResult; /** The decision the person accepted to get here, if any. */ accepted: DecisionKind | null }
  | { ok: false; decision: NeedsDecision; compare: CompareResult | null };

export interface EvaluateInput extends Omit<CompareInput, 'listed' | 'folders' | 'unreadable'> {
  look: PhoneLook;
  policy?: LookPolicy;
  /** Decisions the person already answered "accept" to (never 'look_incomplete' or 'look_name_clash'). */
  accept?: readonly DecisionKind[];
}

const noNumbers = { listed: 0, known: 0, gone: 0, changed: 0 };

export function evaluateLook(input: EvaluateInput): LookOutcome {
  return finishSync(evaluateLookSteps(input));
}

/** `evaluateLook` as slices: the compare of a big look is cut into short turns (see sliceWork.ts). The answer is the same. */
export function* evaluateLookSteps(input: EvaluateInput): Steps<LookOutcome> {
  const { look } = input;
  const policy = input.policy ?? DEFAULT_LOOK_POLICY;
  const accepted = new Set(input.accept ?? []);

  if (!look.complete) {
    return {
      ok: false,
      compare: null,
      decision: {
        kind: 'look_incomplete',
        title: "The phone's file list looks wrong",
        plain: 'The list of files on the phone did not come back complete, so nothing was changed and nothing was planned. Unlock the phone, check the cable and try again.',
        reasons: look.problems.length > 0 ? look.problems.map((p) => `${p.folder}: ${p.detail}`) : ['No phone folder was read.'],
        numbers: { ...noNumbers, listed: look.files.length },
        options: ['try_again'],
      },
    };
  }

  const compare = yield* compareLookSteps({
    listed: look.files,
    folders: look.folders,
    unreadable: look.unreadable,
    indexed: input.indexed,
    ...(input.changeRule ? { changeRule: input.changeRule } : {}),
    ...(input.destinations ? { destinations: input.destinations } : {}),
    ...(input.copies ? { copies: input.copies } : {}),
  });
  const { counts } = compare;
  const numbers = { listed: counts.listed, known: counts.indexedLive, gone: counts.gone, changed: counts.changed };

  if (compare.clashes.length > 0) {
    return {
      ok: false,
      compare,
      decision: {
        kind: 'look_name_clash',
        title: 'Two files on the phone have the same name',
        plain: 'Some phone names look identical once written the standard way (they differ only in how an accent is stored), so Backup Hub cannot tell them apart safely. Nothing was changed.',
        reasons: compare.clashes.slice(0, 5).map((c) => c.join(' = ')),
        numbers,
        options: ['try_again'],
      },
    };
  }

  if (counts.listed === 0 && counts.indexedLive > 0 && !accepted.has('look_empty')) {
    return {
      ok: false,
      compare,
      decision: {
        kind: 'look_empty',
        title: "The phone's file list looks wrong",
        plain: `The phone showed no files in the chosen folders, but ${counts.indexedLive} files were there last time. Nothing was marked gone. Try again, or accept that they are really gone.`,
        reasons: ['An empty file list where files were before (a locked phone, a wrong folder or a failed read look like this).'],
        numbers,
        options: ['try_again', 'accept'],
      },
    };
  }

  const moved = counts.gone + counts.changed;
  // Accepting "the phone really is empty" is the extreme of accepting a mass change: one answer covers both.
  const massOk = accepted.has('look_mass_change') || (counts.listed === 0 && accepted.has('look_empty'));
  if (counts.indexedLive >= policy.massChangeMinFiles && (moved * 100) / counts.indexedLive > policy.massChangePercent && !massOk) {
    return {
      ok: false,
      compare,
      decision: {
        kind: 'look_mass_change',
        title: "The phone's file list looks wrong",
        plain: `${moved} of ${counts.indexedLive} known files look gone or changed since last time (more than ${policy.massChangePercent}%). Nothing was marked gone and nothing was planned. Try again, or accept it.`,
        reasons: [`${counts.gone} gone, ${counts.changed} changed of ${counts.indexedLive} known files.`],
        numbers,
        options: ['try_again', 'accept'],
      },
    };
  }

  const waived: DecisionKind | null = counts.listed === 0 && counts.indexedLive > 0 ? 'look_empty' : moved > 0 && counts.indexedLive >= policy.massChangeMinFiles && (moved * 100) / counts.indexedLive > policy.massChangePercent ? 'look_mass_change' : null;
  return { ok: true, compare, accepted: waived };
}
