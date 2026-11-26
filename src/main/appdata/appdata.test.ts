import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPDATA_MANIFEST, APPDATA_README, appDataPathProblem, isAppDataRelPath, toAppDataSources, type AppDataSource } from '../../shared/plans';
import { JobAborted, JobFailure, type JobContext } from '../jobs/jobService';
import { protectFakeDrive, treeOf, unprotectFakeDrives } from '../writeGuard.testutil';
import { goodCopies, listOldCopies, pruneOldCopies } from './prune';
import { appDataSnapshotHandler, cleanLaptopName, freshDateFolder, laptopFolder, type AppDataRunResult } from './snapshotJob';
import { appDataEnvFromProcess, appNameOf, blockedPaths, orderedSources, resolveSource, toListPath, walkSource, type AppDataEnv } from './sources';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const BS = String.fromCharCode(92);
const slash = (p: string): string => p.split(BS).join('/');

let dir: string;
let env: AppDataEnv;
let drive: string;
let free: number | null;
let here: boolean;
const LAPTOP = { id: 'aaaaaaaa-1111-4222-8333-444444444444', name: 'My Laptop' };

const write = (abs: string, text = abs): void => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

/** A list path written with backslashes, from forward-slash text. */
const lp = (p: string): string => p.split('/').join(BS);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-ad-'));
  env = { appData: path.join(dir, 'home', 'AppData', 'Roaming'), localAppData: path.join(dir, 'home', 'AppData', 'Local'), userProfile: path.join(dir, 'home') };
  drive = path.join(dir, 'T7');
  fs.mkdirSync(drive, { recursive: true });
  free = 500_000_000_000;
  here = true;
  write(path.join(env.appData, 'Notepad++', 'config.xml'), '<config/>');
  write(path.join(env.appData, 'Notepad++', 'backup', 'new 1.txt'), 'draft');
  write(path.join(env.appData, 'Notepad++', 'session.lock'), 'x');
  write(path.join(env.appData, 'Notepad++', 'Cache', 'big.bin'), 'cache');
  write(path.join(env.appData, 'Mozilla', 'Firefox', 'Profiles', 'abc.default', 'places.sqlite'), 'sqlite');
  write(path.join(env.appData, 'Mozilla', 'Firefox', 'Profiles', 'abc.default', 'places.sqlite-wal'), 'wal');
  write(path.join(env.appData, 'Mozilla', 'Firefox', 'Profiles', 'abc.default', 'cache2', 'entries', 'e1'), 'cache');
  write(path.join(env.appData, 'Mozilla', 'Firefox', 'Profiles', 'abc.default', 'lock'), 'x');
  write(path.join(env.appData, 'Mozilla', 'Firefox', 'Profiles', 'def.dev-edition', 'prefs.js'), 'prefs');
  write(path.join(env.localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks'), '{}');
  write(path.join(env.userProfile, '.config', 'gh', 'hosts.yml'), 'oauth_token: SECRET');
  write(path.join(env.userProfile, '.config', 'tool', 'settings.json'), '{}');
});
afterEach(() => {
  vi.restoreAllMocks();
  unprotectFakeDrives();
  fs.rmSync(dir, { recursive: true, force: true });
});

const src = (p: string, priority: AppDataSource['priority'] = 'high', on = true): AppDataSource => ({ path: lp(p), priority, on });

describe('the list and its paths', () => {
  it('resolves %APPDATA% style paths on the given profile and a star in one segment', () => {
    expect(resolveSource(src('%APPDATA%/Notepad++'), env).map((r) => r.abs)).toEqual([path.join(env.appData, 'Notepad++')]);
    const profiles = resolveSource(src('%APPDATA%/Mozilla/Firefox/Profiles/*'), env);
    expect(profiles.map((r) => path.basename(r.abs))).toEqual(['abc.default', 'def.dev-edition']);
    expect(profiles.map((r) => r.folderName)).toEqual(['APPDATA__Mozilla__Firefox__Profiles__abc.default', 'APPDATA__Mozilla__Firefox__Profiles__def.dev-edition']);
    const one = resolveSource(src('%LOCALAPPDATA%/Google/Chrome/User Data/Default/Bookmarks'), env);
    expect(one).toHaveLength(1);
    expect(one[0]!.isFile).toBe(true);
    expect(resolveSource(src('%APPDATA%/Postman'), env)).toEqual([]);
  });

  it('never contains a user or laptop name: only tokens, and the real profile comes from the environment', () => {
    const real = appDataEnvFromProcess({ APPDATA: 'X:/a', LOCALAPPDATA: 'X:/l', USERPROFILE: 'X:/u' });
    expect(real).toEqual({ appData: 'X:/a', localAppData: 'X:/l', userProfile: 'X:/u' });
    expect(toListPath(path.join(env.appData, 'Foo', 'Bar'), env)).toBe(lp('%APPDATA%/Foo/Bar'));
    expect(toListPath(path.join(env.localAppData, 'Foo'), env)).toBe(lp('%LOCALAPPDATA%/Foo'));
    expect(toListPath(path.join(env.userProfile, 'Documents'), env)).toBe(lp('%USERPROFILE%/Documents'));
    expect(toListPath(path.join(dir, 'elsewhere'), env)).toBeNull();
    expect(toListPath(env.appData, env)).toBeNull();
  });

  it('refuses paths without a token, with .., two stars, or the blocked sign-in folders', () => {
    expect(appDataPathProblem(lp('C:/Users/x/AppData/Roaming/Foo'))).not.toBeNull();
    expect(appDataPathProblem(lp('%APPDATA%/../Foo'))).not.toBeNull();
    expect(appDataPathProblem(lp('%APPDATA%/*/*'))).not.toBeNull();
    expect(appDataPathProblem(lp('%APPDATA%/gcloud'))).not.toBeNull();
    expect(appDataPathProblem(lp('%appdata%/GitHub CLI/hosts'))).not.toBeNull();
    expect(appDataPathProblem(lp('%USERPROFILE%/.config/gh'))).not.toBeNull();
    expect(appDataPathProblem(lp('%APPDATA%/Notepad++'))).toBeNull();
    expect(toAppDataSources([{ path: lp('%APPDATA%/gcloud'), priority: 'high', on: true }])).toBeNull();
    expect(toAppDataSources([{ path: lp('%APPDATA%/Vim'), priority: 'urgent', on: true }])).toBeNull();
    expect(toAppDataSources([{ path: lp('%APPDATA%/Vim'), priority: 'low', on: false }, { path: lp('%appdata%/vim'), priority: 'low', on: true }])).toEqual([{ path: lp('%APPDATA%/Vim'), priority: 'low', on: false }]);
  });

  it('orders high, then medium, then low, and leaves out what is switched off', () => {
    const list = [src('%APPDATA%/c', 'low'), src('%APPDATA%/a', 'high'), src('%APPDATA%/b', 'medium'), src('%APPDATA%/off', 'high', false), src('%APPDATA%/a2', 'high')];
    expect(orderedSources(list).map((s) => s.path)).toEqual([lp('%APPDATA%/a'), lp('%APPDATA%/a2'), lp('%APPDATA%/b'), lp('%APPDATA%/c')]);
  });

  it('names the app in plain words', () => {
    expect(appNameOf(lp('%APPDATA%/Mozilla/Firefox/Profiles'))).toBe('Firefox');
    expect(appNameOf(lp('%APPDATA%/Code/User'))).toBe('Code');
    expect(appNameOf(lp('%APPDATA%/Notepad++'))).toBe('Notepad++');
    expect(appNameOf(lp('%LOCALAPPDATA%/Google/Chrome/User Data/Default/Bookmarks'))).toBe('Chrome');
  });

  it('knows the Laptop-AppData folder in any rel_path', () => {
    expect(isAppDataRelPath('Laptop-AppData/Laptop/2026-11-06/x.txt')).toBe(true);
    expect(isAppDataRelPath('Backups/laptop-appdata/x')).toBe(true);
    expect(isAppDataRelPath('Photos/appdata/x')).toBe(false);
  });
});

describe('the walk', () => {
  const walk = async (list: string): Promise<string[]> => {
    const out: string[] = [];
    for (const r of resolveSource(src(list), env)) for await (const f of walkSource(r, blockedPaths(env))) out.push(`${path.basename(r.abs)}/${f.rel}`);
    return out;
  };

  it('skips caches, temporary and lock files', async () => {
    expect(await walk('%APPDATA%/Notepad++')).toEqual(['Notepad++/config.xml', 'Notepad++/backup/new 1.txt']);
    const firefox = await walk('%APPDATA%/Mozilla/Firefox/Profiles/*');
    expect(firefox).toEqual(['abc.default/places.sqlite', 'abc.default/places.sqlite-wal', 'def.dev-edition/prefs.js']);
  });

  it('skips a blocked folder even inside an added parent', async () => {
    expect(await walk('%USERPROFILE%/.config')).toEqual(['.config/tool/settings.json']);
  });
});

interface Ran {
  message: string;
  warns: string[];
  error: unknown;
  record: AppDataRunResult | null;
}

async function run(over: { sources?: AppDataSource[]; yields?: number; now?: Date; chunk?: number } = {}): Promise<Ran> {
  const out: Ran = { message: '', warns: [], error: null, record: null };
  let yields = 0;
  const ctx: JobContext = {
    jobId: 7,
    params: { placeId: 't7', driveLabel: 'T7' },
    resume: null,
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    warn: (t) => void out.warns.push(t),
    needsYou: () => Promise.resolve('continue'),
    checkpoint: () => {},
    yield: () => {
      yields += 1;
      return yields > (over.yields ?? Infinity) ? Promise.reject(new JobAborted()) : Promise.resolve();
    },
  };
  const handler = appDataSnapshotHandler({
    log: silent,
    baseOf: () => Promise.resolve(here ? drive : null),
    freeBytes: () => free,
    sources: () => over.sources ?? [src('%APPDATA%/Notepad++', 'high'), src('%APPDATA%/Mozilla/Firefox/Profiles/*', 'high'), src('%LOCALAPPDATA%/Google/Chrome/User Data/Default/Bookmarks', 'medium')],
    laptop: () => LAPTOP,
    env: () => env,
    now: () => over.now ?? new Date(2026, 10, 6, 12),
    chunkBytes: over.chunk ?? 4,
    record: (_id, r) => void (out.record = r),
  });
  try {
    const result = await handler.run(ctx);
    out.message = typeof result === 'string' ? result : (result?.message ?? '');
  } catch (err) {
    out.error = err;
  }
  return out;
}

const dated = (name = '2026-11-06'): string => path.join(laptopFolder(drive, LAPTOP.name), name);
const files = (folder: string): string[] => treeOf(folder).filter((f) => fs.statSync(path.join(folder, f)).isFile()).map(slash);
const partFiles = (): string[] => treeOf(drive).filter((f) => f.endsWith('.bhpart'));

describe('the snapshot job', () => {
  it('copies the list to <drive>/Laptop-AppData/<laptop>/<date>/ with a manifest and a README, and nothing else', async () => {
    const r = await run();
    expect(r.error).toBeNull();
    expect(r.warns).toEqual([]);
    const names = files(dated());
    expect(names).toContain('APPDATA__Notepad++/config.xml');
    expect(names).toContain('APPDATA__Notepad++/backup/new 1.txt');
    expect(names).toContain('APPDATA__Mozilla__Firefox__Profiles__abc.default/places.sqlite-wal');
    expect(names).toContain('LOCALAPPDATA__Google__Chrome__User Data__Default__Bookmarks/Bookmarks');
    expect(names).toContain(APPDATA_MANIFEST);
    expect(names).toContain(APPDATA_README);
    expect(names.some((n) => /cache|\.lock|\/lock$/i.test(n))).toBe(false);
    expect(fs.readFileSync(path.join(dated(), 'APPDATA__Notepad++', 'config.xml'), 'utf8')).toBe('<config/>');
    expect(partFiles()).toEqual([]);
    const manifest = JSON.parse(fs.readFileSync(path.join(dated(), APPDATA_MANIFEST), 'utf8')) as { device: { id: string; name: string }; date: string; files: { sha256: string; size: number; source: string }[]; skipped: unknown[] };
    expect(manifest.device).toEqual(LAPTOP);
    expect(manifest.date).toBe('2026-11-06');
    expect(manifest.skipped).toEqual([]);
    expect(manifest.files.find((f) => f.source === path.join(env.appData, 'Notepad++', 'config.xml'))).toMatchObject({ size: 9 });
    expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(fs.readFileSync(path.join(dated(), APPDATA_README), 'utf8')).toMatch(/passwords and sign-ins/);
    expect(r.record).toMatchObject({ folder: '2026-11-06', skipped: [] });
    expect(r.record!.files).toBe(manifest.files.length);
    // the laptop's own files are untouched
    expect(fs.readFileSync(path.join(env.appData, 'Notepad++', 'config.xml'), 'utf8')).toBe('<config/>');
  });

  it('puts a second run of the same day in a folder with -2, never into the first', async () => {
    await run();
    await run();
    expect(fs.readdirSync(laptopFolder(drive, LAPTOP.name)).toSorted()).toEqual(['2026-11-06', '2026-11-06-2']);
    expect(await freshDateFolder(laptopFolder(drive, LAPTOP.name), new Date(2026, 10, 6))).toBe('2026-11-06-3');
  });

  it('retries a locked file once at the end, then lists it as skipped and finishes with a warning that names the app', async () => {
    const real = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith('places.sqlite')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return (real as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest);
    });
    const r = await run();
    expect(r.error).toBeNull();
    expect(r.warns).toEqual(['Close Firefox and run again to include 1 file']);
    expect(r.record!.skipped).toEqual([{ app: 'Firefox', count: 1 }]);
    expect(files(dated()).some((f) => f.endsWith('places.sqlite'))).toBe(false);
    expect(files(dated()).some((f) => f.endsWith('places.sqlite-wal'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dated(), APPDATA_MANIFEST), 'utf8')) as { skipped: { app: string; source: string }[] };
    expect(manifest.skipped).toEqual([expect.objectContaining({ app: 'Firefox' })]);
    expect(r.message).toMatch(/1 in use were left out/);
  });

  it('copies a file that was locked only the first time', async () => {
    const real = fs.promises.open.bind(fs.promises);
    let seen = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith('places.sqlite')) {
        seen += 1;
        if (seen === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return (real as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest);
    });
    const r = await run();
    expect(r.warns).toEqual([]);
    expect(files(dated()).some((f) => f.endsWith('places.sqlite'))).toBe(true);
  });

  it('refuses a drive with less than 2 GB free, an unplugged drive, and a protected drive, writing nothing', async () => {
    free = 1_000_000_000;
    expect((await run()).error).toBeInstanceOf(JobFailure);
    expect(fs.readdirSync(drive)).toEqual([]);
    free = 500_000_000_000;
    here = false;
    expect(((await run()).error as JobFailure).plain).toMatch(/not plugged in/);
    here = true;
    protectFakeDrive(drive, 'T7', ['T7']);
    const before = treeOf(drive);
    expect(((await run()).error as JobFailure).plain).toMatch(/read-only|protected/i);
    expect(treeOf(drive)).toEqual(before);
  });

  it('removes only its own leftover .bhpart files, and only in dated folders that never got a manifest', async () => {
    const unfinished = path.join(dated('2026-11-01'), 'APPDATA__X');
    write(path.join(unfinished, 'half.txt.bhpart'), 'half');
    write(path.join(unfinished, 'kept.txt'), 'whole');
    const finished = dated('2026-10-30');
    write(path.join(finished, APPDATA_MANIFEST), '{}');
    write(path.join(finished, 'odd.bhpart'), 'not ours to judge');
    await run();
    expect(fs.existsSync(path.join(unfinished, 'half.txt.bhpart'))).toBe(false);
    expect(fs.existsSync(path.join(unfinished, 'kept.txt'))).toBe(true);
    expect(fs.existsSync(path.join(finished, 'odd.bhpart'))).toBe(true);
  });

  it('fails plainly when none of the folders exist on this laptop', async () => {
    const r = await run({ sources: [src('%APPDATA%/NotInstalled')] });
    expect((r.error as JobFailure).plain).toMatch(/None of the folders/);
    expect(fs.existsSync(laptopFolder(drive, LAPTOP.name))).toBe(false);
  });

  it('can be cancelled and leaves no temporary file behind', async () => {
    const r = await run({ yields: 14 });
    expect(r.error).toBeInstanceOf(JobAborted);
    expect(partFiles()).toEqual([]);
  });

  it('cleans the laptop name for use as a folder', () => {
    expect(cleanLaptopName('My: <Laptop>. ')).toBe('My_ _Laptop_');
    expect(cleanLaptopName('   ')).toBe('Laptop');
  });
});

describe('old dated copies (the only removal)', () => {
  const make = (name: string, id = LAPTOP.id, withManifest = true, laptop = LAPTOP.name): string => {
    const folder = path.join(laptopFolder(drive, laptop), name);
    write(path.join(folder, 'APPDATA__X', 'a.txt'), 'abcd');
    if (withManifest) write(path.join(folder, APPDATA_MANIFEST), JSON.stringify({ format: 'backuphub-appdata', version: 1, device: { id, name: laptop } }));
    return folder;
  };

  it('lists the copies beyond the newest N, only folders with this laptop manifest', () => {
    for (const n of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-03-2', '2026-11-04']) make(n);
    make('2026-10-01', LAPTOP.id, false); // unfinished: never offered
    make('2026-10-02', 'bbbbbbbb-1111-4222-8333-444444444444'); // another laptop's manifest
    write(path.join(laptopFolder(drive, LAPTOP.name), 'not-a-date', APPDATA_MANIFEST), JSON.stringify({ format: 'backuphub-appdata', device: { id: LAPTOP.id } }));
    const old = listOldCopies(drive, LAPTOP, 3);
    expect(old.folders).toEqual(['2026-11-01', '2026-11-02']);
    expect(old.count).toBe(2);
    expect(old.bytes).toBeGreaterThan(8);
    expect(goodCopies(drive, LAPTOP)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-03-2', '2026-11-04']);
  });

  it('removes nothing without the confirm, or when the count or size changed since the person looked', () => {
    for (const n of ['2026-11-01', '2026-11-02', '2026-11-03']) make(n);
    const old = listOldCopies(drive, LAPTOP, 1);
    expect(pruneOldCopies(drive, LAPTOP, 1, { count: old.count, bytes: old.bytes, confirmed: false }).ok).toBe(false);
    expect(pruneOldCopies(drive, LAPTOP, 1, { count: old.count + 1, bytes: old.bytes, confirmed: true }).ok).toBe(false);
    expect(pruneOldCopies(drive, LAPTOP, 1, { count: old.count, bytes: old.bytes + 1, confirmed: true }).ok).toBe(false);
    expect(fs.readdirSync(laptopFolder(drive, LAPTOP.name))).toHaveLength(3);
  });

  it('removes exactly what was shown, leaves unfinished and foreign folders, and keeps the newest N', () => {
    for (const n of ['2026-11-01', '2026-11-02', '2026-11-03']) make(n);
    const unfinished = make('2026-10-01', LAPTOP.id, false);
    const foreign = make('2026-10-02', 'bbbbbbbb-1111-4222-8333-444444444444');
    const otherLaptop = make('2026-10-03', LAPTOP.id, true, 'Other');
    const old = listOldCopies(drive, LAPTOP, 1);
    const result = pruneOldCopies(drive, LAPTOP, 1, { count: old.count, bytes: old.bytes, confirmed: true });
    expect(result).toMatchObject({ ok: true, removed: 2 });
    expect(fs.readdirSync(laptopFolder(drive, LAPTOP.name)).toSorted()).toEqual(['2026-10-01', '2026-10-02', '2026-11-03']);
    expect(fs.existsSync(unfinished) && fs.existsSync(foreign) && fs.existsSync(otherLaptop)).toBe(true);
  });

  it('refuses on a protected drive', () => {
    for (const n of ['2026-11-01', '2026-11-02']) make(n);
    protectFakeDrive(drive, 'T7', ['T7']);
    const old = listOldCopies(drive, LAPTOP, 1);
    expect(() => pruneOldCopies(drive, LAPTOP, 1, { count: old.count, bytes: old.bytes, confirmed: true })).toThrow();
    expect(fs.readdirSync(laptopFolder(drive, LAPTOP.name))).toHaveLength(2);
  });
});

describe('static guards', () => {
  const main = path.join(__dirname, '..');
  const sources = (d: string): { file: string; text: string }[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) return sources(full);
      return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.testutil.ts') ? [{ file: slash(full).split('/src/main/')[1]!, text: fs.readFileSync(full, 'utf8') }] : [];
    });
  const all = sources(main);

  it('the deleters allowlist: only these modules remove a folder tree, and only appdata/prune.ts can reach a backup drive', () => {
    // Since S1 every removal is an ownRemove (danger/ownFiles.ts: it refuses a path outside the app-owned folders); danger/dangerStatic.test.ts forbids the rest.
    const recursive = all.filter((s) => /\bownRemove\([^)]*recursive:\s*true/.test(s.text)).map((s) => s.file);
    // The others work in Backup Hub's own scratch folders (system temp, the data folder): never a path from a drive or the person.
    expect(recursive).toEqual(['appdata/prune.ts', 'db/externalDb.ts', 'import/fleetV1/source.ts', 'listing/cloudOnly.ts', 'recovery/recoveryJob.ts', 'settings/savedCopyActions.ts']);
    expect(all.find((s) => s.file === 'appdata/prune.ts')!.text).toContain('assertWritable(dir)');
  });

  it('the plan code has no other removal: the snapshot job only removes .bhpart leftovers', () => {
    for (const file of ['appdata/sources.ts']) {
      expect(/\b(?:unlinkSync|rmSync|rmdirSync|promises\.(?:rm|unlink))\b/.test(all.find((s) => s.file === file)!.text), file).toBe(false);
    }
    const job = all.find((s) => s.file === 'appdata/snapshotJob.ts')!.text;
    const removals = job.match(/ownRemove(?:Async)?\([^)]*\)/g) ?? [];
    expect(removals).toEqual(['ownRemoveAsync(abs)']);
    expect(job).toMatch(/endsWith\(PART_SUFFIX\)/);
  });

  it('the listing refuses the app data folder', () => {
    expect(all.find((s) => s.file === 'listing/skipRules.ts')!.text).toContain("'laptop-appdata'");
  });

  it('no app data job is queued by itself', () => {
    const services = all.find((s) => s.file === 'appServices.ts')!.text;
    expect(/ensureRecurring\(\s*APPDATA/.test(services)).toBe(false);
    expect(all.find((s) => s.file === 'jobs/builtinJobs.ts')!.text).not.toContain('appdata');
  });
});
