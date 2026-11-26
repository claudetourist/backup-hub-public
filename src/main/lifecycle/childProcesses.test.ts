import type { ChildProcess, ExecFileOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CHILD_ENV_NAME, ChildRegistry, DEFAULT_CHILD_TIMEOUT_MS, POWERSHELL_MARKER, powershellArgs, runChild, spawnChild, type ExecFn } from './childProcesses';
import { cleanUpLeftovers, LEFTOVER_FINDER_SCRIPT, parseSnapshot, selectLeftovers, type ProcessSnapshot } from './leftovers';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

class FakeChild extends EventEmitter {
  killed = 0;
  pid = 4242;
  stdin = Object.assign(new EventEmitter(), { written: undefined as string | undefined, ended: false, end(text?: string) { this.written = text; this.ended = true; } });
  kill(): boolean {
    this.killed += 1;
    return true;
  }
}

function fakeExec() {
  const seen: { file: string; args: readonly string[]; options: ExecFileOptions; child: FakeChild; done: (error: Error | null, stdout?: string, stderr?: string) => void }[] = [];
  const exec: ExecFn = (file, args, options, callback) => {
    const child = new FakeChild();
    seen.push({ file, args, options, child, done: (error, stdout = '', stderr = '') => callback(error, stdout, stderr) });
    return child as unknown as ChildProcess;
  };
  return { exec, seen };
}

describe('child process helper', () => {
  it('records the child while it runs and removes it when it ends; hides the window, sets a time limit and the marker', async () => {
    const registry = new ChildRegistry();
    const { exec, seen } = fakeExec();
    const result = runChild('tool.exe', ['a'], { exec, registry });
    expect(registry.size).toBe(1);
    expect(seen[0]!.options).toMatchObject({ windowsHide: true, timeout: DEFAULT_CHILD_TIMEOUT_MS });
    expect((seen[0]!.options.env as Record<string, string>)[CHILD_ENV_NAME]).toBe('1');
    expect(seen[0]!.child.stdin.ended).toBe(true);
    seen[0]!.done(null, 'out', 'err');
    await expect(result).resolves.toEqual({ stdout: 'out', stderr: 'err' });
    expect(registry.size).toBe(0);
  });

  it('removes the child on failure too, and the error carries stderr; a caller time limit and stdin text are passed on', async () => {
    const registry = new ChildRegistry();
    const { exec, seen } = fakeExec();
    const result = runChild('tool.exe', [], { exec, registry, timeoutMs: 1234, input: 'secret-in' });
    expect(seen[0]!.options.timeout).toBe(1234);
    expect(seen[0]!.child.stdin.written).toBe('secret-in');
    seen[0]!.done(new Error('exit 1'), '', 'bad thing');
    await expect(result).rejects.toMatchObject({ message: 'exit 1', stderr: 'bad thing' });
    expect(registry.size).toBe(0);
  });

  it('endAll ends every recorded child and forgets them; an already-gone child is ignored', () => {
    const registry = new ChildRegistry();
    const a = new FakeChild();
    const b = new FakeChild();
    b.kill = () => {
      throw new Error('gone');
    };
    registry.add(a);
    registry.add(b);
    expect(registry.endAll()).toBe(1);
    expect(a.killed).toBe(1);
    expect(registry.size).toBe(0);
  });

  it('a spawned child is recorded until it exits (or fails to start), and gets the marker and a hidden window', () => {
    const registry = new ChildRegistry();
    const kids: FakeChild[] = [];
    const seenOptions: Record<string, unknown>[] = [];
    const spawnFn = ((_c: string, _a: readonly string[], o: Record<string, unknown>) => {
      seenOptions.push(o);
      const k = new FakeChild();
      kids.push(k);
      return k as unknown as ChildProcess;
    }) as unknown as NonNullable<Parameters<typeof spawnChild>[2]>['spawnFn'];
    spawnChild('x', [], { registry, spawnFn });
    spawnChild('y', [], { registry, spawnFn, env: { A: '1' } });
    expect(registry.size).toBe(2);
    expect(seenOptions[0]).toMatchObject({ windowsHide: true });
    expect((seenOptions[1]!['env'] as Record<string, string>)[CHILD_ENV_NAME]).toBe('1');
    expect((seenOptions[1]!['env'] as Record<string, string>)['A']).toBe('1');
    kids[0]!.emit('exit', 0);
    kids[1]!.emit('error', new Error('ENOENT'));
    expect(registry.size).toBe(0);
  });

  it('a spawned child with a time limit is ended when the limit passes', async () => {
    const registry = new ChildRegistry();
    const kid = new FakeChild();
    spawnChild('x', [], { registry, timeoutMs: 10, spawnFn: (() => kid as unknown as ChildProcess) as never });
    await new Promise((r) => setTimeout(r, 40));
    expect(kid.killed).toBe(1);
  });

  it('every PowerShell command starts with the Backup Hub marker as a comment line, then the script', () => {
    const args = powershellArgs('Get-Date');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toBe(`${POWERSHELL_MARKER}\nGet-Date`);
    expect(POWERSHELL_MARKER).toBe('# BackupHub');
  });
});

describe('leftover cleanup at start', () => {
  const marked = `powershell.exe -NoProfile -NonInteractive -Command "${POWERSHELL_MARKER}\nGet-CimInstance Win32_Volume"`;
  const snapshot = (): ProcessSnapshot => ({
    self: 900,
    alive: [4, 100, 200, 300, 900, 1000],
    procs: [
      { pid: 501, parent: 7777, name: 'powershell.exe', cmd: marked }, // orphan of a dead Backup Hub: ended
      { pid: 502, parent: 7777, name: 'PowerShell.exe', cmd: marked }, // same, other letter case: ended
      { pid: 503, parent: 200, name: 'powershell.exe', cmd: marked }, // its parent is still running: kept
      { pid: 504, parent: 7777, name: 'powershell.exe', cmd: 'powershell.exe -NoProfile -Command "Get-Process"' }, // no marker: kept
      { pid: 505, parent: 7777, name: 'node.exe', cmd: `node.exe -e "${POWERSHELL_MARKER}"` }, // not powershell: kept
      { pid: 506, parent: 7777, name: 'powershell.exe', cmd: `powershell.exe -Command "${POWERSHELL_MARKER} typed by hand"` }, // not a non-interactive helper: kept
      { pid: 900, parent: 7777, name: 'powershell.exe', cmd: marked }, // the finder itself: kept
      { pid: 1000, parent: 7777, name: 'powershell.exe', cmd: marked }, // this app: kept
      { pid: 507, parent: 1000, name: 'powershell.exe', cmd: marked }, // started by this app: kept
    ],
  });

  it('selects only marked, non-interactive PowerShell helpers whose starter is gone, never itself or the finder', () => {
    expect(selectLeftovers(snapshot(), 1000)).toEqual([501, 502]);
  });

  it('ends only the selected processes, then lets go of the phone', async () => {
    const killed: number[] = [];
    const order: string[] = [];
    const out = await cleanUpLeftovers({
      runFinder: async (script) => {
        expect(script).toBe(LEFTOVER_FINDER_SCRIPT);
        return JSON.stringify(snapshot());
      },
      kill: (pid) => void (killed.push(pid), order.push(`kill ${pid}`)),
      ownPid: 1000,
      releaseAdb: async () => void order.push('adb'),
      log: quiet,
    });
    expect(killed).toEqual([501, 502]);
    expect(out.ended).toEqual([501, 502]);
    expect(order).toEqual(['kill 501', 'kill 502', 'adb']);
  });

  it('unreadable finder output, a failing finder or a failing kill: nothing else is ended, adb is still released, nothing throws', async () => {
    for (const runFinder of [async () => 'not json', async () => '{"self":"x"}', async () => { throw new Error('powershell missing'); }]) {
      let adb = 0;
      const killed: number[] = [];
      await cleanUpLeftovers({ runFinder, kill: (pid) => void killed.push(pid), ownPid: 1, releaseAdb: async () => void (adb += 1), log: quiet });
      expect(killed).toEqual([]);
      expect(adb).toBe(1);
    }
    const out = await cleanUpLeftovers({
      runFinder: async () => JSON.stringify(snapshot()),
      kill: () => {
        throw new Error('access denied');
      },
      ownPid: 1000,
      releaseAdb: () => Promise.reject(new Error('adb')),
      log: quiet,
    });
    expect(out.ended).toEqual([]);
  });

  it('reads what PowerShell prints, including a single process and a missing list', () => {
    const one = parseSnapshot(JSON.stringify({ self: 5, alive: 5, procs: { pid: 9, parent: 1, name: 'powershell.exe', cmd: 'x' } }));
    expect(one).toEqual({ self: 5, alive: [5], procs: [{ pid: 9, parent: 1, name: 'powershell.exe', cmd: 'x' }] });
    expect(parseSnapshot(JSON.stringify({ self: 5, alive: [5] }))).toEqual({ self: 5, alive: [5], procs: [] });
    expect(parseSnapshot('')).toBeNull();
    expect(parseSnapshot('[]')).toBeNull();
  });

  it('the finder is read-only and itself marked (it runs through runPowerShell, which adds the marker)', () => {
    expect(LEFTOVER_FINDER_SCRIPT).toMatch(/Get-CimInstance Win32_Process/);
    expect(LEFTOVER_FINDER_SCRIPT).not.toMatch(/Stop-Process|taskkill|\.Kill\(|Remove-/i);
  });
});
