import fs from 'node:fs';
import path from 'node:path';
import { configureWriteGuard, resetWriteGuardForTests } from './fsutil';
import { cardFile, cardFolder } from './places/appFolders';

/** A fake card on a temp folder, as a real drive would have at its root. */
export function putFakeCard(folder: string, name: string, id = '11111111-2222-4333-8444-555555555555'): void {
  fs.mkdirSync(cardFolder(folder), { recursive: true });
  fs.writeFileSync(cardFile(folder), JSON.stringify({ id, name, createdAt: '', appVersion: 'test' }));
}

const roots: string[] = [];

/**
 * Makes the temp `folder` behave like the root of a drive for the write guard, and puts a card named `name` on it.
 * `protectedNames` is the setting value. Call `unprotectFakeDrives` in afterEach.
 */
export function protectFakeDrive(folder: string, name = 'T7', protectedNames: string[] = ['T7']): void {
  putFakeCard(folder, name);
  roots.push(path.resolve(folder));
  configureWriteGuard({
    protectedDrives: () => protectedNames,
    systemRoot: 'ZZ:\\',
    now: () => 0,
    rootOf: (abs) => roots.find((r) => abs === r || abs.startsWith(r + path.sep)) ?? null,
  });
}

export function unprotectFakeDrives(): void {
  roots.length = 0;
  resetWriteGuardForTests();
}

/** Every FILE below `folder`, relative, sorted (folders are not listed). */
export function filesOf(folder: string): string[] {
  return fs
    .readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((rel) => fs.statSync(path.join(folder, rel)).isFile())
    .toSorted();
}

/** Every file and folder below `folder`, relative, sorted. */
export function treeOf(folder: string): string[] {
  return fs.readdirSync(folder, { recursive: true, encoding: 'utf8' }).toSorted();
}
