import { describe, expect, it } from 'vitest';
import { lookPhone, type ShellRunner } from './phoneLook';

describe('the live count while the phone lists its files', () => {
  it('counts the lines as they arrive and still judges the whole listing the same way', async () => {
    const lines = ['10|1700000000|/sdcard/DCIM/a.jpg', '20|1700000000|/sdcard/DCIM/b.jpg', '30|1700000000|/sdcard/DCIM/c.jpg'];
    const run: ShellRunner = async (_serial, _command, _signal, onStdout) => {
      const out = [...lines, '@@BH_END|0|3', ''].join('\n');
      onStdout?.(out.slice(0, 20));
      onStdout?.(out.slice(20));
      return { exitCode: 0, stdout: out, stderr: '' };
    };
    const seen: number[] = [];
    const look = await lookPhone(run, 'SERIAL', ['/sdcard/DCIM'], { onCount: (n) => seen.push(n) });
    expect(look.complete).toBe(true);
    expect(look.files).toHaveLength(3);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThanOrEqual(4);
  });

  it('works without a counter (the runner is given nothing to call)', async () => {
    let given: unknown = 'not called';
    const run: ShellRunner = async (_s, _c, _sig, onStdout) => {
      given = onStdout;
      return { exitCode: 0, stdout: '@@BH_END|0|0\n', stderr: '' };
    };
    await lookPhone(run, 'SERIAL', ['/sdcard/DCIM']);
    expect(given).toBeUndefined();
  });
});
