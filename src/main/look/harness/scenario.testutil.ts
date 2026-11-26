import { ALL_FAULTS, type FaultKind } from './fakePhone.testutil';
import { checkAll, invariant3, invariant4, snapshotIndex, type Violations } from './invariants.testutil';
import { FOLDERS, World, type BackupResult, type Rig } from './world.testutil';
import { Rng } from './rng.testutil';

/**
 * Random sequences of events over the fake world (PLAN.md section 3c "How this is tested"): create, edit, rename, move and delete on the
 * phone; unplug and plug a drive; a look; a backup (sometimes with a failing listing, sometimes killed part-way); the same backup twice.
 * After every event the invariants are checked. The same seed always gives the same sequence, so a failing one is a permanent test.
 */
const NFD = String.fromCharCode(0x75, 0x308);
const STEMS = ['IMG', 'a b', '$HOME', 'semi;colon', '-dash', "it's", 'tick`s', `caf${String.fromCharCode(0xe9)}`, 'x(1)', '#tag', 'pct%', 'amp&', 'bang!', `n${NFD}`, '[br]', '{c}'];
const EXTS = ['.jpg', '.txt', '.mp4', '', '.tar.gz'];
const DIRS = ['DCIM/Camera', 'DCIM/Camera', 'DCIM/Screenshots', 'DCIM/.thumbnails', 'Documents', 'Documents/Work', 'Documents/Work/2026'];

export interface ScenarioStats {
  events: Record<string, number>;
  decisions: Record<string, number>;
  faultsEffective: number;
  crashes: number;
  copies: number;
  cleans: number;
  recordedGone: number;
}

export interface ScenarioResult {
  seed: number;
  events: string[];
  violations: string[];
  stats: ScenarioStats;
}

export interface ScenarioOptions {
  length?: number;
  /** Hook for tests that break the world on purpose (the checks must notice). */
  after?: (w: World, event: string) => void;
}

export async function runScenario(rig: Rig, seed: number, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  const w = new World(rig, { seed });
  const rng = new Rng(seed * 7919 + 13);
  const stats: ScenarioStats = { events: {}, decisions: {}, faultsEffective: 0, crashes: 0, copies: 0, cleans: 0, recordedGone: 0 };
  const log: string[] = [];
  const violations: string[] = [];
  let counter = 0;
  const livePhone = (): string[] => w.phone.walk().map((f) => f.path);
  const newPath = (): string => {
    counter += 1;
    const stem = rng.pick(STEMS);
    return `/sdcard/${rng.pick(DIRS)}/${stem}${counter}${rng.pick(EXTS)}`;
  };
  const note = (event: string, found: Violations): void => {
    log.push(event);
    const word = event.split(' ')[0]!;
    stats.events[word] = (stats.events[word] ?? 0) + 1;
    for (const v of found) violations.push(`seed ${seed}, event ${log.length} (${event}): ${v}`);
    options.after?.(w, event);
    for (const v of checkAll(w)) violations.push(`seed ${seed}, after event ${log.length} (${event}): ${v}`);
  };
  const summarize = (r: BackupResult): void => {
    stats.copies += r.copied;
    if (r.crashed) stats.crashes += 1;
    if (!r.report.outcome.ok) stats.decisions[r.report.outcome.decision.kind] = (stats.decisions[r.report.outcome.decision.kind] ?? 0) + 1;
    stats.recordedGone += r.report.recorded?.markedGone ?? 0;
  };

  // A start: some files, one clean look and backup, so later events have something to change.
  for (let i = 0; i < 16; i += 1) w.createFile(newPath(), `start ${seed} ${i} ${'x'.repeat(rng.int(30))}`);
  w.tick(30);
  try {
    summarize(await w.backup());

    const length = options.length ?? 25;
    for (let n = 0; n < length; n += 1) {
      w.tick(1 + rng.int(90));
      const kind = rng.weighted([
        ['create', 6], ['edit', 3], ['touch', 1], ['rename', 2], ['move', 2], ['delete', 3], ['burst', 1], ['wipe', 0.3],
        ['hours', 1], ['day', 1], ['unplug', 1], ['plug', 2], ['backup', 6], ['look', 2], ['twice', 2], ['clean', 1],
      ] as const);
      const files = livePhone();
      const needsFile = (k: string): boolean => ['edit', 'touch', 'rename', 'move', 'delete', 'clean'].includes(k);
      const chosen = files.length === 0 && needsFile(kind) ? 'create' : kind;
      switch (chosen) {
        case 'create': {
          const p = newPath();
          w.createFile(p, `new ${counter} ${'y'.repeat(1 + rng.int(40))}`);
          note(`create ${p}`, []);
          break;
        }
        case 'edit': {
          if (files.length === 0) break;
          const p = rng.pick(files);
          w.editFile(p, `+${counter}`);
          note(`edit ${p}`, []);
          break;
        }
        case 'touch': {
          if (files.length === 0) break;
          const p = rng.pick(files);
          w.phone.touch(p, w.nowSec + 5);
          note(`touch ${p}`, []);
          break;
        }
        case 'rename':
        case 'move': {
          if (files.length === 0) break;
          const p = rng.pick(files);
          const dot = p.lastIndexOf('.') > p.lastIndexOf('/') ? p.lastIndexOf('.') : p.length;
          counter += 1;
          const to = kind === 'rename' ? `${p.slice(0, p.lastIndexOf('/'))}/renamed${counter}${p.slice(dot)}` : newPath();
          w.phone.move(p, to);
          note(`${kind} ${p} -> ${to}`, []);
          break;
        }
        case 'delete': {
          if (files.length === 0) break;
          const p = rng.pick(files);
          w.phone.remove(p);
          note(`delete ${p}`, []);
          break;
        }
        case 'burst': {
          for (const p of files.filter(() => rng.chance(0.5))) w.phone.remove(p);
          note('burst (half the files deleted)', []);
          break;
        }
        case 'wipe': {
          for (const p of files) w.phone.remove(p);
          note('wipe (every file deleted)', []);
          break;
        }
        case 'hours':
          w.tick(3600 * (1 + rng.int(5)));
          note('hours passed', []);
          break;
        case 'day':
          w.tick(86400);
          note('day passed', []);
          break;
        case 'unplug': {
          const i = rng.int(w.drives.length);
          w.drives[i]!.unplug();
          note(`unplug drive ${i + 1}`, []);
          break;
        }
        case 'plug': {
          for (const d of w.drives) if (!d.plugged) d.plug();
          note('plug all drives', []);
          break;
        }
        case 'look': {
          const before = snapshotIndex(w);
          const report = await w.look();
          if (!report.outcome.ok) stats.decisions[report.outcome.decision.kind] = (stats.decisions[report.outcome.decision.kind] ?? 0) + 1;
          note('look', invariant3(w, before, report));
          break;
        }
        case 'backup': {
          const faulty = rng.chance(0.25);
          let fault: FaultKind | null = null;
          if (faulty) {
            fault = rng.pick(ALL_FAULTS);
            const times = fault === 'empty_ok' || rng.chance(0.5) ? FOLDERS.length : 1;
            for (let i = 0; i < times; i += 1) w.shell.faults.push(fault);
          }
          const liveBefore = w.phoneRows().filter((r) => r.gone_at === null).length;
          const before = snapshotIndex(w);
          const crashAfter = !faulty && rng.chance(0.15) ? 1 + rng.int(12) : undefined;
          let result = await w.backup(crashAfter === undefined ? {} : { crashAfter });
          w.shell.faults.length = 0;
          const extra: Violations = [];
          if (fault !== null) {
            if (w.shell.last.effective) stats.faultsEffective += 1;
            const mustStop = fault !== 'denied_harmless' && fault !== 'empty_ok';
            if (mustStop && result.report.outcome.ok && w.shell.last.effective) extra.push(`X: a file list with the fault "${fault}" was accepted`);
            if (fault === 'empty_ok' && result.report.outcome.ok && liveBefore > 0 && w.shell.last.effective) extra.push('X: an empty file list was accepted where files were before');
          }
          summarize(result);
          extra.push(...invariant3(w, before, result.report));
          // A person answering "accept" to a doubtful look (empty or mass change) is also a path to check.
          if (!result.report.outcome.ok && result.report.outcome.decision.options.includes('accept') && rng.chance(0.5)) {
            const kindToAccept = result.report.outcome.decision.kind;
            const before2 = snapshotIndex(w);
            result = await w.backup({ accept: [kindToAccept] });
            summarize(result);
            extra.push(...invariant3(w, before2, result.report));
            if (!result.report.outcome.ok) extra.push('X: the accepted look was refused again');
          }
          note(`backup${fault ? ` with fault ${fault}` : ''}${crashAfter !== undefined ? ` killed after ${crashAfter} steps` : ''}${result.report.outcome.ok ? '' : ' (decision: ' + result.report.outcome.decision.kind + ')'}`, extra);
          break;
        }
        case 'twice': {
          const first = await w.backup();
          summarize(first);
          const before = snapshotIndex(w);
          const second = await w.backup();
          summarize(second);
          const found = invariant3(w, before, second.report);
          if (first.report.outcome.ok && !first.crashed && second.report.outcome.ok) found.push(...invariant4(first, second));
          note('twice (backup twice in a row)', found);
          break;
        }
        case 'clean': {
          if (files.length === 0) break;
          const p = rng.pick(files);
          if (w.cleanPhoneFile(p)) stats.cleans += 1;
          note(`clean phone file ${p}`, []);
          break;
        }
      }
    }
    // The end: everything plugged in, one more complete look must leave the index equal to the phone.
    for (const d of w.drives) if (!d.plugged) d.plug();
    const before = snapshotIndex(w);
    const last = await w.backup({ accept: ['look_empty', 'look_mass_change'] });
    summarize(last);
    note('final backup (every doubtful look accepted)', invariant3(w, before, last.report));
  } finally {
    w.dispose();
  }
  return { seed, events: log, violations, stats };
}
