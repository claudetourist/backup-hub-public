/**
 * The only way Backup Hub talks to a phone. A small port so tests use a fake; the real one runs adb with a fixed list of
 * commands, all of them READ-ONLY on the phone: list devices, list files, fingerprint a file, copy a file to this PC,
 * stop the adb server. There is deliberately no push, no remove, no install.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChild } from '../lifecycle/childProcesses';
import type { PhoneDevice } from '../../shared/phone';
import { lookPhone, type PhoneLook, type ShellRunner } from './phoneLook';
import { isPullablePhonePath, parseDevices, parseSha256, parseSha256Many, parseSpaces, sha256Command, sha256ManyCommand, SPACES_COMMAND, spaceProbeCommand, type ListedPhoneFile, type RawListing, type Sha256Batch } from './phoneModel';

export interface AdbPort {
  /** False when adb.exe cannot be found. */
  available(): boolean;
  devices(): Promise<PhoneDevice[]>;
  /** Every file below the folders, read only. A folder that does not exist gives nothing. */
  listFiles(serial: string, folders: readonly string[], signal?: AbortSignal): Promise<ListedPhoneFile[]>;
  /** SHA-256 of a file on the phone (null when the phone could not say). */
  sha256(serial: string, remotePath: string, signal?: AbortSignal): Promise<string | null>;
  /** Copies one phone file to a path on this PC (`adb pull -a`: keeps the modified time). `sizeBytes` sizes the time limit. */
  pull(serial: string, remotePath: string, localPath: string, signal?: AbortSignal, sizeBytes?: number): Promise<void>;
  /** Stops the adb server (the phone is let go). */
  killServer(): Promise<void>;
}

/** The complete-listing look (R1.0a). A separate port so the other fakes of `AdbPort` stay as they are. */
export interface AdbLookPort {
  /** Lists the folders with the end marker, stderr and completeness checks; never throws for a failed listing (it says so in the look). */
  lookFiles(serial: string, folders: readonly string[], signal?: AbortSignal, options?: { allowRoot?: boolean }): Promise<PhoneLook>;
}

/** A user space of the phone besides the owner's (second space, work profile) and whether the shell could read it. */
export interface OtherSpace {
  id: string;
  readable: boolean;
}

/** What the phone backup needs from the phone (R1.2a): the complete-listing look, a checksum read on the phone, a pull, and the spaces check. */
export interface PhoneBackupAdb extends AdbLookPort {
  devices(): Promise<PhoneDevice[]>;
  /** SHA-256 of a file on the phone, read on the phone (null when the phone could not say). */
  sha256(serial: string, remotePath: string, signal?: AbortSignal): Promise<string | null>;
  pull(serial: string, remotePath: string, localPath: string, signal?: AbortSignal, sizeBytes?: number): Promise<void>;
  /** SHA-256 of several files on the phone with ONE adb call (read only). `totalBytes` sizes the time limit. Each file gets its own answer; a call that failed as a whole says so. */
  sha256Many(serial: string, remotePaths: readonly string[], signal?: AbortSignal, totalBytes?: number): Promise<Sha256Batch>;
  /** The runner that sends the one fixed listing command (for `runLook`). */
  listRunner(): ShellRunner;
  /** Other user spaces of the phone (/storage/emulated/<id>), with whether they can be read. */
  otherSpaces(serial: string, signal?: AbortSignal): Promise<OtherSpace[]>;
  killServer(): Promise<void>;
}

/**
 * Where adb.exe may be, in order: BACKUPHUB_ADB (the full path of adb.exe, the person's own choice), the PATH, then the Android SDK
 * (ANDROID_HOME, ANDROID_SDK_ROOT, and Android Studio's default folder).
 */
export function adbCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = os.homedir();
  const explicit = env['BACKUPHUB_ADB']?.trim();
  const sdkRoots = [env['ANDROID_HOME'], env['ANDROID_SDK_ROOT'], path.join(env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'), 'Android', 'Sdk')];
  return [
    ...(explicit ? [explicit] : []),
    ...(env['PATH'] ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'adb.exe')),
    ...sdkRoots.filter((r): r is string => !!r?.trim()).map((r) => path.join(r, 'platform-tools', 'adb.exe')),
  ];
}

export function findAdb(candidates: readonly string[] = adbCandidates()): string | null {
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** PhoneBackup's pull time limit (v3_engine.py 136-153): 300 s plus 4 s per MB (about 250 KB/s worst case), at most 4 hours; unknown size: 1 hour. */
export function pullTimeoutMs(sizeBytes?: number): number {
  if (sizeBytes === undefined) return 3_600_000;
  return Math.floor(Math.min(14_400, 300 + (Math.max(0, sizeBytes) / (1024 * 1024)) * 4)) * 1000;
}

export function runAdb(adb: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    runChild(adb, args, { timeoutMs, maxBuffer: 256 * 1024 * 1024, ...(signal ? { signal } : {}) }).then(
      ({ stdout }) => resolve(stdout),
      (err: Error & { stderr?: string }) => reject(Object.assign(new Error((err.stderr ?? '').trim() || err.message), { code: (err as NodeJS.ErrnoException).code })),
    );
  });
}

/** Like `runAdb`, but a failed command is a result, not an error: the exit code and both streams come back as they were. Aborts still throw. */
export async function runAdbRaw(adb: string, args: string[], timeoutMs: number, signal?: AbortSignal, onStdout?: (chunk: string) => void): Promise<RawListing> {
  try {
    const { stdout, stderr } = await runChild(adb, args, { timeoutMs, maxBuffer: 256 * 1024 * 1024, ...(signal ? { signal } : {}), ...(onStdout ? { onStdout } : {}) });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    if (signal?.aborted) throw err;
    const e = err as Error & { code?: unknown; stdout?: string; stderr?: string };
    return { exitCode: typeof e.code === 'number' ? e.code : null, stdout: e.stdout ?? '', stderr: e.stderr ?? '', error: e.message };
  }
}

export class AdbClient implements AdbPort, PhoneBackupAdb {
  private path: string | null | undefined;

  constructor(private readonly find: () => string | null = () => findAdb()) {}

  /** Where adb.exe is (throws when it was not found). */
  protected adbPath(): string {
    if (this.path === undefined) this.path = this.find();
    if (this.path === null) throw new Error('adb.exe was not found.');
    return this.path;
  }

  available(): boolean {
    if (this.path === undefined || this.path === null) this.path = this.find();
    return this.path !== null;
  }

  async devices(): Promise<PhoneDevice[]> {
    return parseDevices(await runAdb(this.adbPath(), ['devices', '-l'], 20_000));
  }

  listRunner(): ShellRunner {
    return (s, command, sig, onStdout) => runAdbRaw(this.adbPath(), ['-s', s, 'shell', command], 600_000, sig, onStdout);
  }

  async lookFiles(serial: string, folders: readonly string[], signal?: AbortSignal, options: { allowRoot?: boolean } = {}): Promise<PhoneLook> {
    return lookPhone(this.listRunner(), serial, folders, { signal, allowRoot: options.allowRoot });
  }

  /** The other user spaces: one fixed read-only shell line, then one fixed read-only probe per number. */
  async otherSpaces(serial: string, signal?: AbortSignal): Promise<OtherSpace[]> {
    const listed = await runAdbRaw(this.adbPath(), ['-s', serial, 'shell', SPACES_COMMAND], 60_000, signal);
    if (listed.exitCode !== 0) return [];
    const out: OtherSpace[] = [];
    for (const id of parseSpaces(listed.stdout)) {
      const probe = await runAdbRaw(this.adbPath(), ['-s', serial, 'shell', spaceProbeCommand(id)], 60_000, signal);
      out.push({ id, readable: probe.exitCode === 0 && probe.stderr.trim() === '' });
    }
    return out;
  }

  /** The files of every folder. A listing that is not complete is an error (never a shorter list), so nothing is planned from it. */
  async listFiles(serial: string, folders: readonly string[], signal?: AbortSignal): Promise<ListedPhoneFile[]> {
    const look = await this.lookFiles(serial, folders, signal);
    if (!look.complete) throw new Error(`The phone's file list is not complete: ${look.problems[0]?.detail ?? 'no folder to list'}`);
    return look.files;
  }

  async sha256(serial: string, remotePath: string, signal?: AbortSignal): Promise<string | null> {
    if (!isPullablePhonePath(remotePath)) return null;
    try {
      return parseSha256(await runAdb(this.adbPath(), ['-s', serial, 'shell', sha256Command(remotePath)], 600_000, signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      return null;
    }
  }

  async sha256Many(serial: string, remotePaths: readonly string[], signal?: AbortSignal, totalBytes?: number): Promise<Sha256Batch> {
    // A name the phone shell must never be given is answered here, without a call (the other files still go).
    const safe = [...new Set(remotePaths)].filter((p) => isPullablePhonePath(p));
    const unsafe = remotePaths.filter((p) => !isPullablePhonePath(p));
    const batch: Sha256Batch = safe.length === 0 ? { answers: new Map(), adbError: null } : parseSha256Many(safe, await runAdbRaw(this.adbPath(), ['-s', serial, 'shell', sha256ManyCommand(safe)], pullTimeoutMs(totalBytes), signal));
    for (const p of unsafe) batch.answers.set(p, { kind: 'error', reason: 'This name cannot be read from the phone safely.' });
    return batch;
  }

  async pull(serial: string, remotePath: string, localPath: string, signal?: AbortSignal, size?: number): Promise<void> {
    if (!isPullablePhonePath(remotePath)) throw new Error('Not a safe phone path.');
    await runAdb(this.adbPath(), ['-s', serial, 'pull', '-a', remotePath, localPath], pullTimeoutMs(size), signal);
  }

  async killServer(): Promise<void> {
    try {
      await runAdb(this.adbPath(), ['kill-server'], 20_000);
    } catch {
      // Nothing to stop.
    }
  }
}
