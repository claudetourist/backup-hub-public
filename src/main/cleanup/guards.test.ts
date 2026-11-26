import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');

const sources = (dir: string): { file: string; text: string }[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [{ file: slash(full), text: readFileSync(full, 'utf8') }] : [];
  });

/** Static guards: where in the code a delete can happen at all. Cheap, and they fail loudly if a future change adds another way. */
describe('where things can be removed', () => {
  const cleanup = sources(__dirname);
  const all = sources(join(__dirname, '..'));

  it('no clean-up module deletes a file from disk itself: every removal goes through danger (see dangerStatic.test.ts)', () => {
    const deleters = cleanup.filter((s) => /\b(unlinkSync|rmSync|rmdirSync|renameSync|promises\.(rm|unlink|rename)|fs\.rm\b)/.test(s.text)).map((s) => s.file.split('/').pop());
    expect(deleters).toEqual([]);
  });

  it('only adbClean.ts can build an adb command that removes or writes on the phone', () => {
    const hits = all
      .filter((s) => /`rm |"rm |'rm |'push'/.test(s.text))
      .map((s) => s.file.split('/').slice(-2).join('/'));
    expect(hits.toSorted()).toEqual(['cleanup/adbClean.ts', 'danger/adbRm.ts']); // push in adbClean; the one-file remove command in danger
  });

  it('the Google client has no delete, trash or update method, one download only through openDownload (Get files back), and clean up never talks to Google', () => {
    const http = readFileSync(join(__dirname, '..', 'google', 'googleHttp.ts'), 'utf8');
    expect(/'(DELETE|PATCH)'/.test(http)).toBe(false);
    expect(http).toContain('There is no DELETE, no PATCH, no trash and no other host');
    expect(http).toContain('A download is only possible through `openDownload`');
    // No clean-up file imports the HTTP layer, the Drive client or the uploader.
    for (const s of cleanup) expect(/google\/(googleHttp|driveApi|driveUpload)'/.test(s.text), s.file).toBe(false);
  });

  it('no clean-up job is scheduled by itself', () => {
    const builtin = readFileSync(join(__dirname, '..', 'jobs', 'builtinJobs.ts'), 'utf8');
    for (const kind of ['clean.phone', 'clean.laptop', 'clean.putBack']) expect(builtin).not.toContain(kind);
    const services = readFileSync(join(__dirname, '..', 'appServices.ts'), 'utf8');
    expect(/ensureRecurring\(\s*(CLEAN|PUT_BACK)/.test(services)).toBe(false);
  });
});
