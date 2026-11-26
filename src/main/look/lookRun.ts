/**
 * One phone look, start to finish (PLAN.md section 3c rule 1): list > compare > guard > record. Nothing is copied here and the phone
 * is only read. An incomplete or doubtful look returns a "Needs your decision" object and writes NOTHING.
 */
import type { ShellRunner, PhoneLook } from '../adb/phoneLook';
import { lookPhone } from '../adb/phoneLook';
import type { Db } from '../db';
import type { ChangeRule } from './compare';
import { finishSliced } from '../sliceWork';
import { evaluateLookSteps, type DecisionKind, type LookOutcome, type LookPolicy } from './lookGuard';
import { loadCopiesSteps, loadDestinations, loadPhoneIndexSteps, recordLook, type RecordedLook } from './lookStore';

export interface RunLookInput {
  db: Db;
  /** The phone's place in `files`. */
  placeId: string;
  serial: string;
  /** Phone folders ("/sdcard/DCIM"). */
  folders: readonly string[];
  run: ShellRunner;
  /** Phones: 'size_and_date' (the default). */
  changeRule?: ChangeRule;
  /** The backup whose destinations "backed up at" is worked out for. */
  backupProfileId?: number;
  policy?: LookPolicy;
  accept?: readonly DecisionKind[];
  now?: () => number;
  signal?: AbortSignal;
  isDropped?: (p: string) => boolean;
  /** Look at the whole storage (the phone backup). */
  allowRoot?: boolean;
  /** Live count of the lines the phone has sent (about one per file), for the person only. */
  onCount?: (lines: number) => void;
  /** Gives the window a turn between slices of work on a big look (a job passes its own `yield`, so Pause and Stop are honoured; default: one event-loop turn). */
  pause?: () => Promise<void>;
}

export interface LookReport {
  look: PhoneLook;
  outcome: LookOutcome;
  /** Null when nothing was recorded (a decision is waiting). */
  recorded: RecordedLook | null;
}

export async function runLook(input: RunLookInput): Promise<LookReport> {
  const { db } = input;
  const look = await lookPhone(input.run, input.serial, input.folders, { signal: input.signal, isDropped: input.isDropped, allowRoot: input.allowRoot, onCount: input.onCount, pause: input.pause });
  if (!look.complete) {
    const outcome = await finishSliced(evaluateLookSteps({ look, indexed: [] }), input.pause);
    return { look, outcome, recorded: null };
  }
  const indexed = await finishSliced(loadPhoneIndexSteps(db, input.placeId, look.folders), input.pause);
  const destinations = input.backupProfileId === undefined ? [] : loadDestinations(db, input.backupProfileId);
  const copies = destinations.length > 0 ? await finishSliced(loadCopiesSteps(db, indexed.map((r) => r.id)), input.pause) : [];
  const outcome = await finishSliced(evaluateLookSteps({
    look,
    indexed,
    destinations,
    copies,
    ...(input.changeRule ? { changeRule: input.changeRule } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.accept ? { accept: input.accept } : {}),
  }), input.pause);
  if (!outcome.ok) return { look, outcome, recorded: null };
  return { look, outcome, recorded: await recordLook(db, input.placeId, outcome.compare, (input.now ?? Date.now)(), input.pause) };
}
