import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../../shared/jobs';
import { workingSummary } from './working';

function job(over: Partial<JobRecord>): JobRecord {
  return { id: 1, kind: 'list.place', title: 'List the laptop', state: 'queued', paused: false, message: null, progressDone: 0, progressTotal: 0, bytesDone: 0, bytesTotal: 0, ...over } as JobRecord;
}

describe('working indicator', () => {
  it('says nothing when nothing runs or waits', () => {
    expect(workingSummary([])).toBeNull();
    expect(workingSummary([job({ state: 'done' }), job({ state: 'failed' }), job({ state: 'needs_you' })])).toBeNull();
  });
  it('shows what the running job is doing and its progress', () => {
    const w = workingSummary([job({ state: 'running', message: 'Uploading a.jpg', progressDone: 1, progressTotal: 4 })])!;
    expect(w.text).toBe('List the laptop: Uploading a.jpg');
    expect(w.percent).toBe(25);
    expect(w.count).toBe(1);
  });
  it('counts the others and ignores paused jobs', () => {
    const w = workingSummary([job({ id: 1, state: 'running' }), job({ id: 2 }), job({ id: 3, paused: true })])!;
    expect(w.count).toBe(2);
    expect(w.text).toBe('List the laptop (and 1 more)');
    expect(workingSummary([job({ paused: true })])).toBeNull();
  });
});
