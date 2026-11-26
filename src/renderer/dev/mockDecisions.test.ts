import { describe, expect, it } from 'vitest';
import type { DecisionAnswerResult, DecisionList, WhyResult } from '../../shared/decisions';
import { createDecisionsMock, mockCases } from './mockDecisions';

const call = async <T>(mock: ReturnType<typeof createDecisionsMock>, name: string, ...args: unknown[]): Promise<T> => ((mock.handlers as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!(...args) as Promise<T>);

describe('the sample "Needs your decision" and "Why?" of the browser mock', () => {
  it('opens with three cases: a drive, a refused look, copies found different', async () => {
    const mock = createDecisionsMock();
    const list = await call<DecisionList>(mock, 'decisions.list', {});
    expect(list.total).toBe(3);
    expect(list.cases.map((c) => c.source)).toEqual(['drive', 'phone_look', 'copy_differs']);
    expect(mockCases()).toHaveLength(3);
  });

  it('an answer takes the case off this pretend list; "the same for the others" takes the similar ones; a wrong answer changes nothing', async () => {
    const mock = createDecisionsMock();
    expect(await call<DecisionAnswerResult>(mock, 'decisions.answer', { key: 'drive:1', choice: 'copy_again' })).toMatchObject({ ok: false });
    expect(await call<DecisionAnswerResult>(mock, 'decisions.answer', { key: 'drive:1', choice: 'same_drive' })).toMatchObject({ ok: true });
    expect(mock.open().map((c) => c.key)).toEqual(['look:1', 'differs:7']);
    expect(await call<DecisionAnswerResult>(mock, 'decisions.answer', { key: 'look:1', choice: 'try_again' })).toMatchObject({ ok: true, jobId: 99 });
    expect(await call<DecisionAnswerResult>(mock, 'decisions.answer', { key: 'differs:7', choice: 'copy_again', similar: true })).toMatchObject({ ok: true, message: expect.stringContaining('12 files') });
    expect(mock.open()).toEqual([]);
    expect(await call<DecisionAnswerResult>(mock, 'decisions.answer', { key: 'differs:7', choice: 'copy_again' })).toMatchObject({ ok: false });
  });

  it('can be narrowed to one backup and to what a run just found', async () => {
    const mock = createDecisionsMock();
    expect((await call<DecisionList>(mock, 'decisions.list', { backupId: 1 })).cases).toHaveLength(2);
    expect((await call<DecisionList>(mock, 'decisions.list', { since: Date.now() + 60_000 })).cases).toEqual([]);
  });

  it('Why? answers for any file with the phone photo that has one checked and one unchecked copy, named after the file asked about', async () => {
    const mock = createDecisionsMock();
    const a = await call<WhyResult>(mock, 'why.file', { backupId: 1, phonePath: '/sdcard/DCIM/Camera/IMG_77.jpg' });
    expect(a).toMatchObject({ ok: true, name: 'IMG_77.jpg' });
    if (a.ok) expect(a.sections.map((s) => s.title)).toEqual(['Where it is and how it was checked', 'Is it left out?', 'Free up phone space', 'What happened to it']);
    expect(await call<WhyResult>(mock, 'why.file', { fileId: 5 })).toMatchObject({ ok: true, name: 'IMG_20260110_142233.jpg' });
  });
});
