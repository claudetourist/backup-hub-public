import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShellRunner } from '../../adb/phoneLook';
import { LIST_END_MARKER, listCommand, type RawListing } from '../../adb/phoneModel';
import { Rng } from './rng.testutil';

/**
 * A phone made of a temporary folder (the phone path /sdcard/x is <folder>/x) and a fake adb that answers the fixed listing command the way
 * a real phone shell does, including the ways a real listing goes wrong. The real adb is never run. Dev machines only: Windows file
 * names, so no new lines in names (the new-line case is covered by crafted text in phoneModel.test.ts).
 */
export interface PhoneFileInfo {
  path: string;
  size: number;
  mtimeSec: number;
}

export class FakePhone {
  readonly root: string;

  constructor(readonly serial = 'FAKE-SERIAL-1') {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-fakephone-'));
  }

  local(remote: string): string {
    return path.join(this.root, ...remote.split('/').slice(2));
  }

  write(remote: string, content: string | Buffer, mtimeSec: number): void {
    const f = this.local(remote);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    fs.utimesSync(f, mtimeSec, mtimeSec);
  }

  touch(remote: string, mtimeSec: number): void {
    fs.utimesSync(this.local(remote), mtimeSec, mtimeSec);
  }

  read(remote: string): Buffer {
    return fs.readFileSync(this.local(remote));
  }

  exists(remote: string): boolean {
    return fs.existsSync(this.local(remote));
  }

  move(from: string, to: string): void {
    const dest = this.local(to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(this.local(from), dest);
  }

  remove(remote: string): void {
    fs.rmSync(this.local(remote), { force: true });
  }

  /** Every file, as the phone would list it (remote paths). */
  walk(): PhoneFileInfo[] {
    const out: PhoneFileInfo[] = [];
    const go = (dir: string, remote: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) go(abs, `${remote}/${e.name}`);
        else if (e.isFile()) {
          const st = fs.statSync(abs);
          out.push({ path: `${remote}/${e.name}`, size: st.size, mtimeSec: Math.floor(st.mtimeMs / 1000) });
        }
      }
    };
    go(this.root, '/sdcard');
    return out;
  }

  dispose(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/** The ways a listing goes wrong. Each is applied to the next listing call only. */
export type FaultKind =
  | 'truncate' // the output stops part-way, even inside a line; adb itself ends normally
  | 'nonzero_exit' // adb ends with an error part-way
  | 'no_marker' // all lines, no end marker
  | 'garbage' // lines that are not listing lines among the real ones
  | 'count_wrong' // the marker's count does not match the lines
  | 'status_silent' // the shell's status is 1 and nothing says why
  | 'denied_harmless' // a folder the filters drop (.thumbnails) was refused: its files are not seen, stderr says so
  | 'denied_harmful' // a folder the filters do not drop was refused
  | 'empty_ok' // a perfectly formed listing of nothing (a locked or wrong-mounted phone)
  | 'locked' // adb: device unauthorized
  | 'wrong_device' // adb: device not found
  | 'unknown_stderr' // a good listing plus a message nobody knows
  | 'vanished_file'; // a file disappeared between find and stat

export const ALL_FAULTS: readonly FaultKind[] = ['truncate', 'nonzero_exit', 'no_marker', 'garbage', 'count_wrong', 'status_silent', 'denied_harmless', 'denied_harmful', 'empty_ok', 'locked', 'wrong_device', 'unknown_stderr', 'vanished_file'];

/** Faults after which the listing may be used as it is (the rest must leave the look incomplete or doubtful). */
export const HARMLESS_FAULTS: readonly FaultKind[] = ['denied_harmless'];

export class FakeAdbShell {
  readonly commands: string[] = [];
  /** Faults for the next listing calls, one per call, oldest first. */
  readonly faults: FaultKind[] = [];
  /** What the last call did: the fault asked for and whether it changed anything (denied_* needs a folder to refuse). */
  last: { fault: FaultKind | null; effective: boolean } = { fault: null, effective: false };
  private readonly rng: Rng;

  constructor(
    private readonly phone: FakePhone,
    seed = 1,
  ) {
    this.rng = new Rng(seed);
  }

  readonly run: ShellRunner = async (serial, command) => {
    this.commands.push(command);
    const folder = /^\{ find -H '(.*)' -type f -printf /.exec(command)?.[1];
    if (folder === undefined || command !== listCommand(folder)) throw new Error('The fake phone only answers the one file-list command: ' + command);
    const fault = this.faults.shift() ?? null;
    this.last = { fault, effective: fault !== null };
    return this.answer(serial, folder, fault);
  };

  private answer(serial: string, folder: string, fault: FaultKind | null): RawListing {
    if (serial !== this.phone.serial || fault === 'wrong_device') return { exitCode: 1, stdout: '', stderr: `adb: device '${serial}' not found\n`, error: 'adb failed' };
    if (fault === 'locked') return { exitCode: 1, stdout: '', stderr: 'error: device unauthorized.\n', error: 'adb failed' };
    let files = this.phone.walk().filter((f) => f.path.startsWith(`${folder}/`));
    let stderr = '';
    let status = 0;
    if (!this.exists(folder)) {
      return { exitCode: 0, stdout: `${LIST_END_MARKER}|1|0\n`, stderr: `find: '${folder}': No such file or directory\n` };
    }
    if (fault === 'denied_harmless' || fault === 'denied_harmful') {
      const dirs = new Set<string>();
      for (const f of files) {
        const parts = f.path.split('/');
        for (let i = 1; i < parts.length - 1; i += 1) {
          const dir = parts.slice(0, i + 1).join('/');
          const hit = fault === 'denied_harmless' ? parts[i] === '.thumbnails' : parts[i] === 'Camera';
          if (hit && dir.startsWith(folder)) dirs.add(dir);
        }
      }
      this.last.effective = dirs.size > 0;
      for (const d of dirs) {
        files = files.filter((f) => !f.path.startsWith(`${d}/`));
        stderr += `find: '${d}': Permission denied\n`;
        status = 1;
      }
    }
    if (fault === 'empty_ok') files = [];
    if (fault === 'vanished_file' && files.length > 0) {
      const gone = files[this.rng.int(files.length)]!;
      files = files.filter((f) => f !== gone);
      stderr += `stat: cannot statx '${gone.path}': No such file or directory\n`;
      status = 1;
    }
    if (fault === 'status_silent') status = 1;
    if (fault === 'unknown_stderr') stderr += 'toybox: something unexpected happened\n';
    const lines = files.map((f) => `${f.size}|${f.mtimeSec}|${f.path}`);
    let shown = [...lines];
    if (fault === 'garbage') {
      for (let i = 0; i < 1 + this.rng.int(2); i += 1) shown.splice(this.rng.int(shown.length + 1), 0, this.rng.pick(['garbage ## line', '|||', '12|x|/sdcard/y', '']));
      if (shown.join('') === lines.join('')) shown.push('garbage ## line');
    }
    let count = lines.length;
    if (fault === 'count_wrong') count += this.rng.chance(0.5) || count === 0 ? 1 : -1;
    const marker = `${LIST_END_MARKER}|${status}|${count}`;
    let stdout = shown.map((l) => `${l}\n`).join('') + `${marker}\n`;
    if (fault === 'no_marker') stdout = shown.map((l) => `${l}\n`).join('');
    if (fault === 'truncate') {
      const body = shown.map((l) => `${l}\n`).join('');
      stdout = body.slice(0, this.rng.int(Math.max(1, body.length)));
    }
    if (fault === 'nonzero_exit') return { exitCode: 1, stdout: stdout.slice(0, Math.floor(stdout.length / 2)), stderr: 'adb: error: connection reset\n', error: 'adb failed' };
    return { exitCode: 0, stdout, stderr };
  }

  private exists(remoteFolder: string): boolean {
    return this.phone.exists(remoteFolder);
  }
}
