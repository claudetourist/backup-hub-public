import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanFolders, isDroppedPath, isPullablePhonePath, isSafePhonePath, listCommand, parseDevices, parseListing, parseSha256, parseSpaces, quotePhonePath, sha256Command, skipReason, spaceProbeCommand, type RawListing } from './phoneModel';

describe('model', () => {
  it('only accepts plain paths under /sdcard for the adb shell', () => {
    expect(isSafePhonePath('/sdcard/DCIM/Camera/a b (1).jpg')).toBe(true);
    for (const bad of ['/data/x', '/sdcard/../data', "/sdcard/it's.jpg", '/sdcard/a\nb', '/sdcard/./a', 'sdcard/a', 5, null]) expect(isSafePhonePath(bad)).toBe(false);
    expect(cleanFolders(['/sdcard/DCIM/', '/sdcard/DCIM', '/sdcard', "/sdcard/a'b", 3, '/sdcard/Pictures'])).toEqual(['/sdcard/DCIM', '/sdcard/Pictures']);
    // A folder to list never has a quote (cleanFolders refuses it); a file path with one is quoted the one safe way.
    expect(() => listCommand("/sdcard/x'; rm -rf /; '")).not.toThrow();
    expect(() => sha256Command('/data/x')).toThrow();
  });

  it('reads adb text', () => {
    expect(parseSha256(`${'AB'.repeat(32)}  /sdcard/a.jpg\n`)).toBe('ab'.repeat(32));
    expect(parseSha256('sha256sum: no such file')).toBeNull();
    expect(parseDevices('List of devices attached\nS1\tdevice usb:1 product:ocean model:POCO_F4 device:ocean\nS2\tunauthorized usb:2\n\n')).toEqual([
      { serial: 'S1', model: 'POCO F4', state: 'device' },
      { serial: 'S2', model: 'S2', state: 'unauthorized' },
    ]);
  });

  it('leaves out caches and temporary files', () => {
    expect(skipReason('/sdcard/DCIM/.thumbnails/1.jpg')).not.toBeNull();
    expect(skipReason('/sdcard/Download/a.crdownload')).not.toBeNull();
    expect(skipReason('/sdcard/DCIM/Camera/IMG_1.jpg')).toBeNull();
  });
});

const ENDLINE = (status: string | number, n: number): string => `@@BH_END|${status}|${n}\n`;
const ok = (stdout: string, extra: Partial<RawListing> = {}): RawListing => ({ exitCode: 0, stdout, stderr: '', ...extra });

describe('the one quoting function (hostile names)', () => {
  const hostile = ['/sdcard/a b', '/sdcard/$HOME', '/sdcard/`id`', '/sdcard/a;b', '/sdcard/a|b&c', '/sdcard/$(rm x)', '/sdcard/-rf', '/sdcard/--help/x', '/sdcard/a*?[b]', '/sdcard/{a,b}', '/sdcard/a\\b', '/sdcard/a"b', '/sdcard/~', '/sdcard/!x', '/sdcard/#c', '/sdcard/a%b'];

  it('wraps a safe path in single quotes, every special character stays inside them', () => {
    for (const p of hostile) {
      expect(isSafePhonePath(p), p).toBe(true);
      expect(quotePhonePath(p)).toBe(`'${p}'`);
      expect(listCommand(p)).toContain(`find -H '${p}' -type f`);
      expect(sha256Command(p)).toBe(`sha256sum '${p}'`);
    }
  });

  it('refuses what a single-quoted word cannot hold: a new line, a control character, a way out of /sdcard', () => {
    for (const bad of ['/sdcard/a\nb', '/sdcard/a\rb', '/sdcard/a\x00b', '/sdcard/a\tb', '/sdcard/../data', '/sdcard/x/..', '/data/x', 'sdcard/x', '-rf', '', '/sdcard/\x7f']) {
      expect(() => quotePhonePath(bad), JSON.stringify(bad)).toThrow();
      expect(() => listCommand(bad), JSON.stringify(bad)).toThrow();
      expect(() => sha256Command(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('a path comes out of the quoting only as one single-quoted word', () => {
    for (const p of hostile) expect(listCommand(p).startsWith(`{ find -H '${p}' -type f -printf`)).toBe(true);
    expect((listCommand('/sdcard/DCIM').match(/'\/sdcard\//g) ?? []).length).toBe(1);
  });

  it('keeps errors visible: no error stream is thrown away and there is an end marker', () => {
    const cmd = listCommand('/sdcard/DCIM');
    expect(cmd).not.toContain('/dev/null');
    expect(cmd).not.toMatch(/2>/);
    expect(cmd).toContain('@@BH_END');
    expect(cmd).toContain('@@BH_STATUS');
  });
});

describe('names with a single quote (R1.2a)', () => {
  it('writes the quote the one standard way and nothing can end the word early', () => {
    expect(quotePhonePath("/sdcard/it's.jpg")).toBe(`'/sdcard/it'\\''s.jpg'`);
    expect(sha256Command("/sdcard/x'; echo hacked; '")).toBe(`sha256sum '/sdcard/x'\\''; echo hacked; '\\'''`);
    expect(isPullablePhonePath("/sdcard/it's.jpg")).toBe(true);
    expect(isPullablePhonePath('/sdcard/a\nb')).toBe(false);
  });

  it('a real shell reads the quoted name back as the same single word (nothing runs)', () => {
    const names = ["/sdcard/it's", "/sdcard/x'; echo hacked; '", "/sdcard/'", "/sdcard/''a", '/sdcard/$(echo hi)`id`', "/sdcard/a'b'c d"];
    for (const name of names) {
      const r = spawnSync('sh', ['-c', `printf '%s' ${quotePhonePath(name)}`], { encoding: 'utf8' });
      if (r.error) return; // no sh on this machine: the exact text above is still checked
      expect(r.stdout, name).toBe(name);
    }
  });

  it('lets the whole storage through only when asked', () => {
    expect(cleanFolders(['/sdcard'])).toEqual([]);
    expect(cleanFolders(['/sdcard/', '/sdcard/DCIM'], { allowRoot: true })).toEqual(['/sdcard', '/sdcard/DCIM']);
  });

  it('reads the other spaces of the phone', () => {
    expect(parseSpaces('0\nself\nemulated\n999\n10\n')).toEqual(['999', '10']);
    expect(spaceProbeCommand('999')).toBe('ls /storage/emulated/999');
    expect(() => spaceProbeCommand('9;rm')).toThrow();
  });
});

describe('the complete-listing check', () => {
  const F = '/sdcard/DCIM';

  it('a clean listing is complete', () => {
    const r = parseListing(F, ok(`123|1700000000|/sdcard/DCIM/a|b.jpg\r\n7|8|/sdcard/DCIM/c d.txt\n${ENDLINE(0, 2)}`));
    expect(r).toMatchObject({ complete: true, problems: [], absent: false, unreadable: [] });
    expect(r.files).toEqual([
      { size: 123, mtimeSec: 1_700_000_000, path: '/sdcard/DCIM/a|b.jpg' },
      { size: 7, mtimeSec: 8, path: '/sdcard/DCIM/c d.txt' },
    ]);
  });

  it('an empty folder with its marker is complete (empty is for the 30% rule to judge)', () => {
    expect(parseListing(F, ok(ENDLINE(0, 0)))).toMatchObject({ complete: true, files: [] });
  });

  it.each([
    ['adb exited non-zero', { ...ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(0, 1)}`), exitCode: 1 }, 'adb_failed'],
    ['adb did not end normally (timed out or killed)', { ...ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(0, 1)}`), exitCode: null, error: 'timed out' }, 'adb_failed'],
    ['the marker is missing (output stopped part-way)', ok('1|1|/sdcard/DCIM/a\n2|2|/sdcard/DCIM/b\n'), 'no_marker'],
    ['the output stopped in the middle of a line', ok('1|1|/sdcard/DCIM/a\n2|2|/sd'), 'no_marker'],
    ['nothing at all came back', ok(''), 'no_marker'],
    ['the shell status is not 0', ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(2, 1)}`), 'status'],
    ['the status is missing', ok(`1|1|/sdcard/DCIM/a\n${ENDLINE('none', 1)}`), 'status'],
    ['status 1 with nothing on stderr to explain it', ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(1, 1)}`), 'status'],
    ['the count is lower than the lines read', ok(`1|1|/sdcard/DCIM/a\n2|2|/sdcard/DCIM/b\n${ENDLINE(0, 1)}`), 'count'],
    ['the count is higher than the lines read', ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(0, 2)}`), 'count'],
    ['a garbage line (never skipped quietly)', ok(`1|1|/sdcard/DCIM/a\nthis is not a listing\n${ENDLINE(0, 2)}`), 'unparsed'],
    ['a name with a new line in it breaks into pieces', ok(`1|1|/sdcard/DCIM/a\nb.jpg\n${ENDLINE(0, 2)}`), 'unparsed'],
    ['a file outside the folder', ok(`1|1|/sdcard/Other/a\n${ENDLINE(0, 1)}`), 'unparsed'],
    ['text after the marker', ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(0, 1)}more\n`), 'bad_marker'],
    ['two markers', ok(`${ENDLINE(0, 0)}${ENDLINE(0, 0)}`), 'bad_marker'],
    ['an unknown message on stderr', ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(0, 1)}`, { stderr: 'error: closed\n' }), 'stderr'],
    ['a refused folder that the filters do NOT drop', ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(1, 1)}`, { stderr: "find: '/sdcard/DCIM/Camera': Permission denied\n" }), 'stderr'],
    ['a vanished file', ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(1, 1)}`, { stderr: "stat: cannot statx '/sdcard/DCIM/gone.jpg': No such file or directory\n" }), 'stderr'],
  ] as const)('is NOT complete when %s', (_why, raw, kind) => {
    const r = parseListing(F, raw);
    expect(r.complete).toBe(false);
    expect(r.problems.map((p) => p.kind)).toContain(kind);
  });

  it('a refused folder that the filters drop anyway is harmless, and its files are named as not seen', () => {
    const lq = String.fromCharCode(0x2018);
    const rq = String.fromCharCode(0x2019);
    for (const err of ["find: '/sdcard/DCIM/.thumbnails': Permission denied", 'find: /sdcard/DCIM/.thumbnails: Permission denied', `find: ${lq}/sdcard/DCIM/.thumbnails${rq}: Permission denied`]) {
      const r = parseListing(F, ok(`1|1|/sdcard/DCIM/a\n${ENDLINE(1, 1)}`, { stderr: `${err}\n` }));
      expect(r, err).toMatchObject({ complete: true, unreadable: ['/sdcard/DCIM/.thumbnails'] });
    }
    expect(parseListing('/sdcard/Android', ok(ENDLINE(1, 0), { stderr: "find: '/sdcard/Android/data': Permission denied\n" }))).toMatchObject({ complete: true, unreadable: ['/sdcard/Android/data'] });
    expect(isDroppedPath('/sdcard/Android/media/com.whatsapp')).toBe(false);
    expect(isDroppedPath('/sdcard/DCIM/Camera')).toBe(false);
  });

  it('the folder itself missing is explained; adb daemon notices are ignored', () => {
    const r = parseListing(F, ok(ENDLINE(1, 0), { stderr: "* daemon not running; starting now at tcp:5037\n* daemon started successfully\nfind: '/sdcard/DCIM': No such file or directory\n" }));
    expect(r).toMatchObject({ complete: true, absent: true, files: [] });
  });

  it('one bad line anywhere spoils the folder even if the rest is fine', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `${i}|${i}|/sdcard/DCIM/f${i}.jpg\n`).join('');
    expect(parseListing(F, ok(`${lines}${ENDLINE(0, 500)}`)).complete).toBe(true);
    expect(parseListing(F, ok(`${lines}garbage\n${ENDLINE(0, 501)}`)).complete).toBe(false);
    expect(parseListing(F, ok(`${lines.slice(0, -40)}${ENDLINE(0, 500)}`)).complete).toBe(false);
  });
});

/** Runs the real command text in a POSIX shell on a temp folder (GNU tools here, toybox on the phone): the shell logic, not the phone. */
const shell = ['C:/Program Files/Git/bin/bash.exe', '/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
describe.skipIf(!shell)('the command text in a real shell', () => {
  const run = (cmd: string, cwd: string): { stdout: string; stderr: string } => {
    const bin = path.dirname(shell!);
    const r = spawnSync(shell!, ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(bin, '..', 'usr', 'bin')}${path.delimiter}${bin}${path.delimiter}${process.env['PATH'] ?? ''}` } });
    return { stdout: r.stdout, stderr: r.stderr };
  };

  it('prints one line per file, then the marker with status 0 and the count; hostile names stay literal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-shell-'));
    try {
      const names = ['plain.jpg', 'a b.jpg', '$HOME.txt', 'semi;colon.txt', '-dash.txt', 'sub/deep file.txt'];
      for (const n of names) {
        fs.mkdirSync(path.dirname(path.join(dir, 'DCIM', n)), { recursive: true });
        fs.writeFileSync(path.join(dir, 'DCIM', n), 'xyz');
      }
      const cmd = listCommand('/sdcard/DCIM').replace("'/sdcard/DCIM'", "'DCIM'");
      const { stdout, stderr } = run(cmd, dir);
      const lines = stdout.split('\n').filter(Boolean);
      expect(lines[lines.length - 1]).toBe(`@@BH_END|0|${names.length}`);
      expect(lines.slice(0, -1).map((l) => l.split('|').slice(2).join('|')).toSorted()).toEqual(names.map((n) => `DCIM/${n}`).toSorted());
      expect(lines[0]).toMatch(/^3\|\d+(?:\.\d+)?\|DCIM\//);
      expect(stderr).toBe('');
      expect(fs.readdirSync(dir)).toEqual(['DCIM']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries find's failure into the marker and its message onto stderr (a missing folder)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-shell-'));
    try {
      const { stdout, stderr } = run(listCommand('/sdcard/Nope').replace("'/sdcard/Nope'", "'Nope'"), dir);
      expect(stdout.trim()).toMatch(/^@@BH_END\|[1-9]\d*\|0$/);
      expect(stderr).toMatch(/Nope/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
