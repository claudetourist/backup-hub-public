/**
 * "Needs your decision" (PLAN.md section 3b) and "Why?" on a file. Types and the plain words only (main and the window both use them).
 * Whenever the app meets something it cannot decide safely it changes nothing, finishes the rest, and shows the case here with what
 * happened in plain words and two or three choices. Main builds the list from cases that already exist (a drive that may not be the
 * same drive, a look at the phone that was refused, copies that are not the same as the phone's file); it has no table of its own, and an
 * answer is always handed to the part that owns the case.
 */

export type DecisionSource = 'drive' | 'phone_look' | 'copy_differs' | 'mirror';

/** answer = main does it; open = the window opens the file in Explorer with the search's own "Show in folder" (nothing is changed). */
export interface DecisionChoice {
  id: DecisionChoiceId;
  label: string;
  /** One quiet line under the button. */
  hint?: string;
  action: 'answer' | 'open';
}

export type DecisionChoiceId = 'same_drive' | 'other_drive' | 'try_again' | 'accept' | 'copy_again' | 'show_file' | 'leave_as_is';

export interface DecisionCase {
  /** "drive:12", "look:3" (the backup), "differs:77": the id of the case. */
  key: string;
  source: DecisionSource;
  headline: string;
  /** What happened, in plain words, and what was and was not changed. */
  what: string;
  /** When it was found (epoch ms). */
  at: number;
  /** Buttons. Empty when nothing can be answered here: `note` says what to do. */
  choices: DecisionChoice[];
  /** Shown instead of buttons when there are none. */
  note: string | null;
  /** The backup it belongs to, when it belongs to one. */
  backupId: number | null;
  /** For "Show the file": the copy on the drive. */
  fileId: number | null;
  /** How many OTHER open cases the same answer would cover ("Do the same for the other 11 copies"); 0 = none. */
  similar: number;
}

export interface DecisionListRequest {
  /** Only cases of this backup. */
  backupId?: number | undefined;
  /** Only cases found at or after this time (the cases a run produced). */
  since?: number | undefined;
}

export interface DecisionList {
  cases: DecisionCase[];
  /** All open cases (the list is cut at `DECISIONS_LIMIT`). */
  total: number;
}

export const DECISIONS_LIMIT = 100;

export interface DecisionAnswerRequest {
  key: string;
  choice: Exclude<DecisionChoiceId, 'show_file'>;
  /** Also answer the other cases the same way (only where the case says `similar`). */
  similar?: boolean | undefined;
}

export type DecisionAnswerResult = { ok: true; message: string; jobId: number | null } | { ok: false; message: string };

export const DECISION_CHOICE_LABELS: Record<DecisionChoiceId, string> = {
  same_drive: 'Yes, it is the same drive',
  other_drive: 'No, keep it blocked',
  try_again: 'Try again',
  accept: 'Accept it',
  copy_again: 'Copy it again at the next backup',
  show_file: 'Show the file',
  leave_as_is: 'Leave it as it is',
};

/** The key of each kind of case, and how to read one back. */
export const decisionKey = {
  drive: (id: number): string => `drive:${id}`,
  look: (backupId: number): string => `look:${backupId}`,
  differs: (problemId: number): string => `differs:${problemId}`,
  /** A damaged copy on the first drive, or a different file already on the second (file_problems of the mirror). */
  mirror: (problemId: number): string => `mirror:${problemId}`,
};

export function parseDecisionKey(key: string): { source: DecisionSource; id: number } | null {
  const m = /^(drive|look|differs|mirror):([1-9]\d{0,12})$/.exec(key);
  if (!m) return null;
  return { source: m[1] === 'drive' ? 'drive' : m[1] === 'look' ? 'phone_look' : m[1] === 'mirror' ? 'mirror' : 'copy_differs', id: Number(m[2]) };
}

// ---- "Why?" on a file ---------------------------------------------------------------------------------------------------------------

/** One plain line. `tone` only helps the eye: the words say the same. */
export interface WhyLine {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'quiet';
}

export interface WhySection {
  title: string;
  lines: WhyLine[];
}

export type WhyRequest = { fileId: number } | { backupId: number; phonePath: string };

export type WhyResult = { ok: true; name: string; headline: string; sections: WhySection[] } | { ok: false; message: string };
