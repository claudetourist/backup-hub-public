/**
 * What the window calls for "Needs your decision": the list (read only) and the person's answer. The list is built by needsDecision.ts;
 * an answer is handed to the part that owns the case, so there is never a second writer:
 *  - a drive: PlaceService.answerDriveDecision (the same drive, or keep it blocked);
 *  - a refused look: PhoneBackupService.startLook (try again, or accept an empty / mass-change look; a half list can never be accepted);
 *  - copies found different: checkOldStore.acknowledgeDiffers (marks seen; the next backup copies the phone's file again anyway).
 * The answer is checked against the open case again here (the window is never trusted). Nothing is removed, renamed or copied.
 */
import { parseDecisionKey, type DecisionAnswerRequest, type DecisionAnswerResult, type DecisionList, type DecisionListRequest } from '../../shared/decisions';
import type { Db } from '../db';
import { acknowledgeDiffers } from '../phoneBackup/checkOldStore';
import { acknowledgeMirror } from '../mirror/mirrorStore';
import { clearRefusal, loadRefusal } from '../phoneBackup/lookRefusals';
import type { PhoneBackupStartResult } from '../../shared/phoneBackup';
import type { AnswerResult, DriveDecision } from '../places/driveDecisions';
import { backupOfDiffers, listNeedsDecision } from './needsDecision';

export interface DecisionOwners {
  places: { driveDecisions(onlyOpen?: boolean): DriveDecision[]; answerDriveDecision(id: number, answer: 'accepted' | 'rejected'): AnswerResult };
  phoneBackup: { startLook(backupId: unknown, accept?: unknown): PhoneBackupStartResult };
}

export interface DecisionServiceDeps extends DecisionOwners {
  db: Db;
  log?: { info(...args: unknown[]): void };
  /** Tells the window that the data changed (the counts on Home). */
  changed?: () => void;
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export class DecisionService {
  constructor(private readonly deps: DecisionServiceDeps) {}

  /** The open cases (read only). */
  list(request: DecisionListRequest = {}): DecisionList {
    const backupId = isId(request?.backupId) ? request.backupId : undefined;
    const since = typeof request?.since === 'number' && Number.isFinite(request.since) ? request.since : undefined;
    return listNeedsDecision(this.deps.db, { backupId, since });
  }

  answer(request: DecisionAnswerRequest): DecisionAnswerResult {
    const no = (message: string): DecisionAnswerResult => ({ ok: false, message: `${message} Nothing was changed.` });
    const parsed = typeof request?.key === 'string' ? parseDecisionKey(request.key) : null;
    if (!parsed) return no('That is not a valid request.');
    const { db } = this.deps;
    const done = (message: string, jobId: number | null = null): DecisionAnswerResult => {
      this.deps.changed?.();
      return { ok: true, message, jobId };
    };

    if (parsed.source === 'drive') {
      if (request.choice !== 'same_drive' && request.choice !== 'other_drive') return no('That answer does not fit this question.');
      const result = this.deps.places.answerDriveDecision(parsed.id, request.choice === 'same_drive' ? 'accepted' : 'rejected');
      if (!result.ok) return no(result.message);
      this.deps.log?.info(`decisions: drive question ${parsed.id} answered "${request.choice}"`);
      return done(request.choice === 'same_drive' ? 'Done. Backup Hub remembers this drive as it is now.' : 'Done. Nothing will be written to that drive.');
    }

    if (parsed.source === 'phone_look') {
      const refusal = loadRefusal(db, parsed.id);
      if (!refusal) return no('That question is not open any more.');
      if (request.choice !== 'try_again' && request.choice !== 'accept') return no('That answer does not fit this question.');
      if (request.choice === 'accept' && !(refusal.canAccept && (refusal.kind === 'look_empty' || refusal.kind === 'look_mass_change'))) return no('This list can only be tried again: accepting it could record names that are cut short.');
      const started = this.deps.phoneBackup.startLook(parsed.id, request.choice === 'accept' ? [refusal.kind] : []);
      if (!started.ok) return no(started.message);
      clearRefusal(db, parsed.id);
      this.deps.log?.info(`decisions: refused look of backup ${parsed.id} answered "${request.choice}"`);
      return done('Reading the phone again. When the list is ready, it is on the Backups screen. Nothing is copied yet.', started.jobId);
    }

    if (parsed.source === 'mirror') {
      if (request.choice !== 'leave_as_is') return no('That answer does not fit this question.');
      if (acknowledgeMirror(db, parsed.id) === 0) return no('That question is not open any more.');
      this.deps.log?.info(`decisions: mirror question ${parsed.id} marked as seen`);
      return done('Done. The file stays as it is on both drives and is not offered again.');
    }

    // Copies found different.
    if (request.choice !== 'copy_again') return no('That answer does not fit this question.');
    // "Do the same for the other copies": every open one of the same backup (the person ticked the box next to the button).
    const backupId = request.similar === true ? backupOfDiffers(db, parsed.id) : null;
    const marked = backupId !== null ? acknowledgeDiffers(db, { backupId }) : acknowledgeDiffers(db, { problemId: parsed.id });
    if (marked === 0) return no('That question is not open any more.');
    this.deps.log?.info(`decisions: ${marked} different cop${marked === 1 ? 'y' : 'ies'} marked as seen`);
    return done(marked === 1 ? 'Done. The next backup copies the phone file again. Your old copy stays where it is.' : `Done. The next backup copies those ${marked} files again. Your old copies stay where they are.`);
  }
}
