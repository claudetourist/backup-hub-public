/**
 * Dev only (compiled out of production builds): "Needs your decision" on Home and "Why?" on a file for a plain browser (`#/home?mock`,
 * `#/backups?mock`, `#/files?mock`). Three cases are open: a drive that may not be the same drive, a refused look at the phone (it can be
 * accepted), and a copy found different (eleven more like it). Answering removes the case from this pretend list only; nothing is stored.
 * "Why?" answers for any file with the example of a phone photo that has one checked copy (T7) and one that is not checked yet (the Seagate).
 */
import { decisionKey, DECISION_CHOICE_LABELS, type DecisionAnswerRequest, type DecisionAnswerResult, type DecisionCase, type DecisionList, type DecisionListRequest, type WhyRequest, type WhyResult } from '../../shared/decisions';
import { checkedWords, dayWords } from '../../shared/whyWords';

const NOW = Date.now();

/** The facts of the pretend photo: the same numbers the real explanation is tested with (mockDecisions.test.ts compares the two). */
export const MOCK_WHY_FACTS = {
  name: 'IMG_20260110_142233.jpg',
  phoneFolder: 'DCIM/Camera',
  t7Folder: 'MyData/POCO/POCO-05Oct26/DCIM/Camera',
  seagateFolder: 'Backups/POCO/POCO-05Oct26/DCIM/Camera',
  backupName: 'Poco F4',
  firstSeen: Date.UTC(2026, 8, 1, 12),
  lastSeen: Date.UTC(2026, 10, 23, 12),
  copiedRun: Date.UTC(2026, 9, 5, 12),
  t7CheckedAt: Date.UTC(2026, 9, 6, 12),
} as const;

/** The explanation of the pretend photo, built from the same words as the real one. */
export function mockWhy(name: string = MOCK_WHY_FACTS.name): Extract<WhyResult, { ok: true }> {
  const f = MOCK_WHY_FACTS;
  const t7 = checkedWords({ verified_how: 'read_both', verified_at: f.t7CheckedAt, place_kind: 'drive', last_seen_at: f.lastSeen });
  const seagate = checkedWords({ verified_how: 'imported', verified_at: null, place_kind: 'drive', last_seen_at: f.lastSeen });
  return {
    ok: true,
    name,
    headline: '3 copies: the phone, T7, Seagate2TB',
    sections: [
      {
        title: 'Where it is and how it was checked',
        lines: [
          { text: `This file: On the phone, in ${f.phoneFolder}: the original`, tone: 'quiet' },
          { text: `On T7, in ${f.t7Folder}: ${t7.text}`, tone: t7.tone },
          { text: `On Seagate2TB, in ${f.seagateFolder}: ${seagate.text}`, tone: seagate.tone },
        ],
      },
      { title: 'Is it left out?', lines: [{ text: `Nothing leaves it out: ${f.backupName} offers it for copying.`, tone: 'ok' }] },
      {
        title: 'Free up phone space',
        lines: [
          { text: 'Not yet. Free up phone space needs a checked copy on T7, Seagate2TB, Google. Missing: Seagate2TB, Google.', tone: 'warn' },
          { text: 'T7: a checked copy', tone: 'ok' },
          { text: `Seagate2TB: a copy, but ${seagate.text}`, tone: 'warn' },
          { text: 'Google: no copy', tone: 'bad' },
        ],
      },
      {
        title: 'What happened to it',
        lines: [
          { text: `First seen on ${dayWords(f.firstSeen)}.`, tone: 'quiet' },
          { text: `Last seen on the phone on ${dayWords(f.lastSeen)}.`, tone: 'quiet' },
          { text: `Copied to T7 by the backup of ${dayWords(f.copiedRun)}.`, tone: 'quiet' },
          { text: `Copied to Seagate2TB by the backup of ${dayWords(f.copiedRun)}.`, tone: 'quiet' },
        ],
      },
    ],
  };
}

const choice = (id: DecisionCase['choices'][number]['id'], hint?: string): DecisionCase['choices'][number] => ({ id, label: DECISION_CHOICE_LABELS[id], action: id === 'show_file' ? 'open' : 'answer', ...(hint ? { hint } : {}) });

/** The three open cases of the pretend list. */
export function mockCases(): DecisionCase[] {
  return [
    {
      key: decisionKey.drive(1),
      source: 'drive',
      headline: 'Is this still T7?',
      what: 'A drive that has the name card of T7 is plugged in, but its own identification number is not the one Backup Hub remembers. Nothing is written to it until you say.',
      at: NOW - 12 * 60_000,
      choices: [choice('same_drive', 'Backup Hub remembers the new number from now on'), choice('other_drive', 'Nothing is written to it')],
      note: null,
      backupId: null,
      fileId: null,
      similar: 0,
    },
    {
      key: decisionKey.look(1),
      source: 'phone_look',
      headline: 'Poco F4: many files look gone or changed',
      what: '412 of 1204 known files look gone or changed since last time (more than 30%). Nothing was marked gone and nothing was planned. Try again, or accept it.',
      at: NOW - 55 * 60_000,
      choices: [choice('try_again', 'Reads the phone again; nothing is copied yet'), choice('accept', 'Only if you know the change is real')],
      note: null,
      backupId: 1,
      fileId: null,
      similar: 0,
    },
    {
      key: decisionKey.differs(7),
      source: 'copy_differs',
      headline: "IMG_20260110_142233.jpg: the copy on T7 is not the same as the phone's file",
      what: 'Check old copies read both files and they are different. Your copy on T7 was not touched. The next backup copies the phone\'s file again into a new folder.',
      at: NOW - 3 * 3_600_000,
      choices: [choice('copy_again', 'This is what happens anyway; this only marks it as seen'), choice('show_file', 'Opens the folder on T7')],
      note: null,
      backupId: 1,
      fileId: 501,
      similar: 11,
    },
  ];
}

export interface DecisionsMock {
  handlers: Record<string, unknown>;
  /** Opens one more case (the second drive's mock adds the cases a copy found). */
  add(c: DecisionCase): void;
  /** The cases still open (the test reads it). */
  open(): DecisionCase[];
}

export function createDecisionsMock(): DecisionsMock {
  let cases = mockCases();
  const list = (request: DecisionListRequest): DecisionList => {
    const shown = cases.filter((c) => (request.backupId === undefined || c.backupId === request.backupId) && (request.since === undefined || c.at >= request.since));
    return { cases: shown, total: shown.length };
  };
  const answer = (request: DecisionAnswerRequest): DecisionAnswerResult => {
    const found = cases.find((c) => c.key === request.key);
    if (!found || !found.choices.some((c) => c.id === request.choice)) return { ok: false, message: 'That question is not open any more. Nothing was changed.' };
    cases = cases.filter((c) => (request.similar === true && c.source === found.source && found.source === 'copy_differs' ? false : c.key !== found.key));
    const text: Record<string, string> = {
      same_drive: 'Done. Backup Hub remembers this drive as it is now.',
      other_drive: 'Done. Nothing will be written to that drive.',
      try_again: 'Reading the phone again. When the list is ready, it is on the Backups screen. Nothing is copied yet.',
      accept: 'Reading the phone again. When the list is ready, it is on the Backups screen. Nothing is copied yet.',
      leave_as_is: 'Done. The file stays as it is on both drives and is not offered again.',
      copy_again: request.similar === true ? 'Done. The next backup copies those 12 files again. Your old copies stay where they are.' : 'Done. The next backup copies the phone file again. Your old copy stays where it is.',
    };
    return { ok: true, message: text[request.choice] ?? 'Done.', jobId: request.choice === 'try_again' || request.choice === 'accept' ? 99 : null };
  };
  const why = (request: WhyRequest): WhyResult => mockWhy('phonePath' in request ? (request.phonePath.split('/').pop() ?? MOCK_WHY_FACTS.name) : MOCK_WHY_FACTS.name);
  return {
    open: () => cases,
    add: (c) => {
      cases = [c, ...cases];
    },
    handlers: {
      'decisions.list': (request: DecisionListRequest) => Promise.resolve(list(request ?? {})),
      'decisions.answer': (request: DecisionAnswerRequest) => Promise.resolve(answer(request)),
      'why.file': (request: WhyRequest) => Promise.resolve(why(request)),
    },
  };
}
