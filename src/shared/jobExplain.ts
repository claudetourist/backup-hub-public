import { QUARANTINE_WORDS } from './appFolders';
import { NO_RETRY_JOB_KINDS } from './cleanup';
import { isContinuable, parseJobError, PAUSED_SAFE_MESSAGE, PAUSING_MESSAGE, type JobErrorCode, type JobRecord } from './jobs';

/**
 * One place that turns a job record into plain words for the Activity screen: what happened, what was not changed, what to do
 * next, and whether Retry can help. Pure (no Electron, no Node), so the window and the tests use the same function.
 * The kind of end comes from the code stored in front of the error text (see parseJobError); jobs that stopped by surprise
 * get their code from describeError in the job service.
 */

export type ExplainedStatus = 'waiting' | 'paused' | 'running' | 'needs_you' | 'done' | 'warning' | 'failed' | 'stopped' | 'interrupted';

export interface JobExplanation {
  status: ExplainedStatus;
  /** What happened, in one plain line. */
  headline: string;
  /** What was not changed (your files, the drive, the phone); null while the job is still going or finished cleanly. */
  whatWasNotChanged: string | null;
  /** What to do next. */
  whatToDo: string;
  /** Retry is shown only when allowed; otherwise `why` is shown in small text. */
  retry: { allowed: boolean; why: string };
}

export type ExplainInput = Pick<JobRecord, 'id' | 'kind' | 'state' | 'error' | 'warnings' | 'message' | 'paused'> & { pausing?: boolean } & { retriedBy?: number | null; hasCheckpoint?: boolean };

export interface ExplainContext {
  /** The newest run of the same kind that finished after this one (done or done with warnings), if there is one. */
  newerFinished?: { id: number; finishedAt: number | null } | null;
}

/** Clean-up jobs remove or move things: never retried, they need a new plan and a new confirm. */
export function neverRetried(kind: string): boolean {
  return kind.startsWith('clean.') || NO_RETRY_JOB_KINDS.includes(kind);
}

/** What upkeep and read-only kinds never touch; the copy and clean-up jobs say what they did touch. */
export function safetyLine(kind: string): string {
  switch (kind) {
    case 'phone.backup':
      return 'Nothing was changed or removed on the phone, and nothing was deleted or overwritten on the drive. Files already copied are new copies and stay there.';
    case 'folder.backup':
      return 'Nothing in the folder was changed, and nothing was deleted or overwritten on the drive. Files already copied are new, checked copies and stay there.';
    case 'folder.look':
      return 'Nothing was copied. Backup Hub only read the names, sizes and dates of the files in the folder and on the drive.';
    case 'mirror.copy':
      return 'Nothing on the first drive was changed, and nothing on the second drive was deleted or overwritten. Files already copied are new, checked copies and stay there.';
    case 'mirror.checkOld':
      return 'Nothing was changed on either drive: files were only read. A file found to be the same is now marked as a verified copy in the file list; a different one was never replaced.';
    case 'mirror.look':
      return 'Nothing was copied. Backup Hub only read the names, sizes and dates of the files on both drives.';
    case 'clean.phone':
      return 'Only files that were checked again right before their removal were removed; every other file is still on the phone. Each removal is in the log on the Clean up screen.';
    case 'freeup.check':
      return 'Nothing was changed or removed: the phone and the copies were only read.';
    case 'freeup.remove':
      return 'Only files that were checked again right before their removal were removed; every other file is still on the phone. Each removal is in the log, and Put back restores them.';
    case 'clean.putBack':
      return 'Nothing was removed. Files already put back were checked against their checksum.';
    case 'clean.laptop':
      return `Nothing was deleted. Files already moved are in ${QUARANTINE_WORDS} and Undo puts them back.`;
    case 'copy.toLocal':
      return 'Nothing was deleted or overwritten. Files already copied to the drive are new copies and stay there; your originals were only read.';
    case 'restore.files':
      return 'Nothing was deleted or overwritten, and nothing on the backup drive was changed. Files already brought back are new, checked copies and stay where they are.';
    case 'settings.saveToDrive':
      return 'Only the settings copy on the backup drive was affected. Your files were not changed.';
    case 'list.place':
    case 'list.lookAgain':
    case 'hash.files':
    case 'drive.refresh':
    case 'files.classify':
      return 'Your files were not changed. Backup Hub only reads them to keep its list up to date.';
    default:
      return 'Backup Hub did not delete or change any of your files.';
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const dayText = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** The first sentence of a text, and the rest (empty when there is only one). */
function splitFirstSentence(text: string): { first: string; rest: string } {
  const match = /^(.*?[.!?])\s+([\s\S]*)$/.exec(text.trim());
  return match ? { first: match[1]!, rest: match[2]! } : { first: text.trim(), rest: '' };
}

/** Short headline and next step for the errors the job service recognises (by code). */
const KNOWN: Partial<Record<JobErrorCode, { headline: string; whatToDo: string }>> = {
  network: { headline: 'The internet connection was lost.', whatToDo: 'Check the connection, then Retry. It carries on where it can.' },
  google: { headline: 'Google did not accept a request.', whatToDo: 'Try again in a little while. If it keeps happening, sign the account in again under Settings, Drives and accounts.' },
  'disk-full': { headline: 'A disk is full.', whatToDo: 'Free some space on that disk, then Retry.' },
  access: { headline: 'Windows refused access to a file or folder.', whatToDo: 'Check that nothing else is using it and that the drive is not read-only, then Retry.' },
  'drive-gone': { headline: 'A drive stopped answering.', whatToDo: 'Check the cable and that the drive is still plugged in, then Retry.' },
  busy: { headline: 'The data file was busy with another task for too long.', whatToDo: 'Retry in a moment. It carries on where it can.' },
  unexpected: { headline: 'Something unexpected went wrong.', whatToDo: 'Retry. If it stops again, copy the technical details below and pass them on.' },
};

export function explainJob(job: ExplainInput, ctx: ExplainContext = {}): JobExplanation {
  const noRetry = (why: string): { allowed: boolean; why: string } => ({ allowed: false, why });
  const clean = neverRetried(job.kind);
  const cleanWhy = 'A clean-up is never repeated by itself. Plan it and confirm it again on the Clean up screen.';
  switch (job.state) {
    case 'queued':
      return job.paused
        ? job.pausing === true
          ? { status: 'paused', headline: PAUSING_MESSAGE, whatWasNotChanged: null, whatToDo: 'It is finishing the file it is on and saving its place. Wait for "Paused" before you close the app. Choose Resume to go on.', retry: noRetry('') }
          : { status: 'paused', headline: PAUSED_SAFE_MESSAGE, whatWasNotChanged: null, whatToDo: 'Nothing is lost. Choose Resume to continue.', retry: noRetry('') }
        : { status: 'waiting', headline: job.message ?? 'Waiting for its turn', whatWasNotChanged: null, whatToDo: 'Nothing to do. It starts when the job before it is finished.', retry: noRetry('') };
    case 'running':
      return { status: 'running', headline: job.message ?? 'Working', whatWasNotChanged: null, whatToDo: 'Nothing to do.', retry: noRetry('') };
    case 'needs_you':
      return { status: 'needs_you', headline: job.message ?? 'Waiting for your answer', whatWasNotChanged: null, whatToDo: 'Answer in the details of this job.', retry: noRetry('') };
    case 'done':
      return { status: 'done', headline: job.message ?? 'Finished', whatWasNotChanged: null, whatToDo: 'Nothing to do.', retry: noRetry('') };
    case 'done_warnings': {
      const n = job.warnings.length;
      const base = job.message ?? 'Finished';
      return {
        status: 'warning',
        headline: n > 0 ? `${base}, with ${n} ${n === 1 ? 'thing' : 'things'} to look at` : base,
        whatWasNotChanged: safetyLine(job.kind),
        whatToDo: 'Open the details to see each one. Retry picks up files that were busy or a drive that was not there.',
        retry: clean ? noRetry(cleanWhy) : { allowed: true, why: 'Trying again can pick up what was skipped.' },
      };
    }
    default: {
      const { code, text } = parseJobError(job.error);
      const notChanged = safetyLine(job.kind);
      if (code === 'stopped-by-you') {
        return {
          status: 'stopped',
          headline: 'Stopped by you',
          whatWasNotChanged: notChanged,
          whatToDo: 'Start it again from the screen where you started it, whenever you like.',
          retry: noRetry('You stopped it on purpose.'),
        };
      }
      if (code === 'stopped-by-app') {
        return {
          status: 'stopped',
          headline: text,
          whatWasNotChanged: notChanged,
          whatToDo: 'Backup Hub stopped it for the reason above. Start it again when that is sorted out.',
          retry: clean ? noRetry(cleanWhy) : { allowed: true, why: 'Backup Hub stopped it, not you; trying again is safe.' },
        };
      }
      if (code === 'interrupted') {
        const base = { status: 'interrupted' as const, headline: text || 'Interrupted when the app closed', whatWasNotChanged: notChanged };
        if (clean) return { ...base, whatToDo: 'Plan it again on the Clean up screen if you still want it.', retry: noRetry(cleanWhy) };
        if (isContinuable(job)) {
          return { ...base, whatToDo: 'Nothing continues by itself. Press Continue to carry on from where it stopped, or Dismiss if you do not need it.', retry: noRetry('Use Continue to carry on from where it stopped.') };
        }
        if (job.retriedBy != null) return { ...base, whatToDo: `Nothing to do. It was started again as job #${job.retriedBy}.`, retry: noRetry(`Already started again as job #${job.retriedBy}.`) };
        if (ctx.newerFinished) {
          const when = ctx.newerFinished.finishedAt === null ? '' : ` on ${dayText(ctx.newerFinished.finishedAt)}`;
          const why = `A newer one finished${when}, so there is nothing to catch up on.`;
          return { ...base, whatToDo: 'Nothing to do.', retry: noRetry(why) };
        }
        return { ...base, whatToDo: 'Retry to run it again. Nothing newer has finished.', retry: { allowed: true, why: 'No newer run has finished.' } };
      }
      if (code === 'refused') {
        return {
          status: 'failed',
          headline: text,
          whatWasNotChanged: notChanged,
          whatToDo: 'Backup Hub refused to start this on purpose, to keep your files safe. Fix what the line above says (plug in the right drive, free some space, check the cable), then start it again.',
          retry: noRetry('It would be refused again until that is fixed.'),
        };
      }
      const known = code === null ? undefined : KNOWN[code];
      const parts = splitFirstSentence(text || 'It did not finish');
      const retry = clean ? noRetry(cleanWhy) : { allowed: true, why: 'Trying again can help.' };
      return {
        status: 'failed',
        headline: known?.headline ?? parts.first,
        whatWasNotChanged: notChanged,
        whatToDo: known?.whatToDo ?? (parts.rest !== '' ? parts.rest : 'Retry. If it stops again, copy the technical details below and pass them on.'),
        retry,
      };
    }
  }
}
