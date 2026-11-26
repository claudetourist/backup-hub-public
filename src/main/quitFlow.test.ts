import { describe, expect, it } from 'vitest';
import { createBeforeQuit } from './quitFlow';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('quit order', () => {
  it('holds the quit, runs the one shutdown routine, and only then lets the quit through', async () => {
    const log: string[] = [];
    let finish: () => void = () => undefined;
    const quit = createBeforeQuit({
      shutdown: { run: (reason) => new Promise<void>((resolve) => { log.push(`shutdown ${reason}`); finish = () => { log.push('shutdown done'); resolve(); }; }) },
      quitAgain: () => { log.push('quit again'); quit({ preventDefault: () => log.push('prevented again') }); },
    });
    let prevented = 0;
    quit({ preventDefault: () => { prevented += 1; } });
    expect(prevented).toBe(1);
    expect(log).toEqual(['shutdown quit']);
    // A second quit request while the routine runs is held too, and starts nothing new.
    quit({ preventDefault: () => { prevented += 1; } });
    expect(prevented).toBe(2);
    expect(log).toEqual(['shutdown quit']);
    finish();
    await tick();
    expect(log).toEqual(['shutdown quit', 'shutdown done', 'quit again']);
  });

  it('still quits when the routine fails', async () => {
    const log: string[] = [];
    const quit = createBeforeQuit({
      shutdown: { run: () => Promise.reject(new Error('x')) },
      quitAgain: () => { log.push('quit again'); quit({ preventDefault: () => log.push('should not be held') }); },
    });
    quit({ preventDefault: () => undefined });
    await tick();
    expect(log).toEqual(['quit again']);
  });
});
