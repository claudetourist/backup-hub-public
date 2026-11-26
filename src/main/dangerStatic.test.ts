import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * S1 static test (PLAN.md section 4 rule 3): the only code that may remove, rename over, trash or delete is `main/danger/`.
 * Everything else asks it. A new module that calls any of these fails here.
 */
const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');

const sources = (dir: string): { file: string; text: string }[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    const isCode = e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.testutil.ts');
    return isCode ? [{ file: slash(full).split('/src/main/')[1]!, text: readFileSync(full, 'utf8') }] : [];
  });

/** Comments are not calls: block comments and whole-line comments are dropped before scanning. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const REMOVERS = '(?:rename|renameSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)';
/** fs.rmSync(...), fs.promises.rm(...), fsp.unlink(...), rawFs.renameSync(...), nodeFs.rm(...): any name that has "fs" in it. */
const CALL = new RegExp('\\b\\w*[Ff][Ss]\\w*\\.(?:promises\\.)?' + REMOVERS + '\\b');
/** import { rm, unlinkSync } from 'node:fs' (also 'fs', 'fs/promises', 'node:fs/promises', 'original-fs'). */
const IMPORT = new RegExp("import\\s*(?:type\\s*)?\\{[^}]*\\b" + REMOVERS + "\\b[^}]*\\}\\s*from\\s*'(?:node:)?(?:original-)?fs(?:/promises)?'");
/** Destructured require or dynamic import of fs, and a bare .promises.xyz call. */
const REQUIRE = new RegExp("\\{[^}]*\\b" + REMOVERS + "\\b[^}]*\\}\\s*=\\s*(?:await\\s+import|require)\\(\\s*'(?:node:)?(?:original-)?fs(?:/promises)?'");
const PROMISES = new RegExp('\\.promises\\.' + REMOVERS + '\\b');
const ADB_RM = /shell['"]\s*,\s*['"]rm\b|`rm |"rm |'rm /;
/** The builder of the rm line may be named only in danger and in the phone transport class (the port method that only danger calls). */
const ADB_BUILDER = /\bremoveCommand\b|\bremoveArgs\b/;
const GOOGLE = /\bfiles\.delete\b|\bemptyTrash\b|\bempty_trash\b|files\.update[\s\S]{0,200}trashed|\btrashed\s*:\s*true|["']trashed["']\s*:\s*true|\/trash\b|method:\s*['"]DELETE['"]/;

describe('S1: no module outside main/danger removes, renames over, trashes or deletes', () => {
  const all = sources(join(__dirname));
  const outside = all.filter((s) => !s.file.startsWith('danger/'));
  const inside = all.filter((s) => s.file.startsWith('danger/'));

  it('finds the danger modules and their calls (so this test cannot pass by finding nothing)', () => {
    expect(inside.map((s) => s.file).toSorted()).toEqual(expect.arrayContaining(['danger/adbRm.ts', 'danger/index.ts', 'danger/ownFiles.ts']));
    expect(inside.some((s) => CALL.test(code(s.text)))).toBe(true);
    expect(code(inside.find((s) => s.file === 'danger/adbRm.ts')!.text)).toMatch(ADB_RM);
    expect(code(inside.find((s) => s.file === 'danger/adbRm.ts')!.text)).toMatch(ADB_BUILDER);
    expect(outside.length).toBeGreaterThan(50);
  });

  it('fs and fs/promises: no rename, rm, rmdir or unlink call, no destructured import of them', () => {
    const hits = outside.filter((s) => CALL.test(code(s.text)) || IMPORT.test(code(s.text)) || REQUIRE.test(code(s.text)) || PROMISES.test(code(s.text))).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it('no module outside danger builds an adb shell rm', () => {
    const hits = outside.filter((s) => ADB_RM.test(code(s.text))).map((s) => s.file);
    expect(hits).toEqual([]);
    expect(outside.filter((s) => ADB_BUILDER.test(code(s.text))).map((s) => s.file)).toEqual(['cleanup/adbClean.ts']);
  });

  it('the phone transport method is handed to danger and called nowhere else', () => {
    const hits: string[] = [];
    for (const s of outside) {
      for (const line of code(s.text).split('\n')) {
        if (/\badb\.remove\(/.test(line) && !/\badbRemove\s*:/.test(line)) hits.push(`${s.file}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no Google trash, delete or empty-trash call outside danger (and the app has no such endpoint)', () => {
    const hits = outside.filter((s) => GOOGLE.test(code(s.text))).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it('the scan recognises what it is meant to catch', () => {
    for (const bad of ['fs.rmSync(p, { force: true });', 'await fs.promises.unlink(p);', 'fsp.rename(a, b)', 'rawFs.renameSync(a, b)', 'nodeFs.rm(p)']) expect(CALL.test(bad) || PROMISES.test(bad), bad).toBe(true);
    for (const bad of ["import { rm } from 'node:fs/promises';", "import { renameSync, readFileSync } from 'fs';", "import { unlink } from 'original-fs';"]) expect(IMPORT.test(bad), bad).toBe(true);
    for (const bad of ["adb(['-s', s, 'shell', 'rm', p])", 'const c = `rm ${p}`;', 'drive.files.delete({ fileId })', 'await files.emptyTrash()', 'body: { trashed: true }', "method: 'DELETE'"]) expect(ADB_RM.test(bad) || GOOGLE.test(bad), bad).toBe(true);
    for (const fine of ['fs.readFileSync(p)', 'fs.mkdirSync(d)', 'const rename = 1; profiles.rename(id, n)', 'set.delete(x)', 'trashed = false']) expect(CALL.test(fine) || IMPORT.test(fine) || GOOGLE.test(fine) || ADB_RM.test(fine), fine).toBe(false);
  });
});
