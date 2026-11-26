import { describe, expect, it } from 'vitest';
import { blockedLine, blockingProgram, ejectScript, EjectService, jobsUsing, programFromVeto, type EjectDeps, type EjectJobs } from './eject';

const T7 = { placeId: 'aaaa-t7', label: 'T7', root: 'F:\\' };
const noLog = { info: () => {}, warn: () => {} };

interface FakeJob {
  id: number;
  kind: string;
  title: string;
  params: unknown;
}

function jobsOf(list: FakeJob[]): EjectJobs & { cancelled: number[] } {
  const cancelled: number[] = [];
  return {
    cancelled,
    list: () => list.map(({ id, kind, title }) => ({ id, kind, title })),
    params: (id) => list.find((j) => j.id === id)?.params ?? null,
    cancelByApp: (id) => {
      cancelled.push(id);
      return true;
    },
  };
}

function service(over: Partial<EjectDeps> & { jobs: EjectJobs }): { svc: EjectService; scripts: string[] } {
  const scripts: string[] = [];
  let clock = 0;
  const svc = new EjectService({
    drives: () => [T7],
    refresh: async () => undefined,
    powershell: async (script) => {
      scripts.push(script);
      return script.includes('InvokeVerb') ? 'SENT\r\n' : '';
    },
    stillThere: async () => false,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: noLog,
    ...over,
  });
  return { svc, scripts };
}

const VETO_OWN = 'The application \\Device\\HarddiskVolume3\\Users\\me\\AppData\\Local\\BackupHub\\app-0.1.0\\BackupHub.exe with process id 5320 stopped the removal or ejection for the device USB\\VID_04E8&PID_4001\\0123.';
const VETO_OTHER = 'The application \\Device\\HarddiskVolume3\\Program Files\\Some\\Backup.exe with process id 12 stopped the removal or ejection for the device X.';

describe('which jobs use a drive', () => {
  it('finds jobs that name the drive, fingerprinting of every place, and drive-wide kinds; leaves the rest', () => {
    const jobs = jobsOf([
      { id: 1, kind: 'list.place', title: 'List T7', params: { placeId: 'aaaa-t7' } },
      { id: 2, kind: 'list.place', title: 'List laptop', params: { placeId: 'laptop' } },
      { id: 3, kind: 'hash.files', title: 'Fingerprint everything', params: {} },
      { id: 4, kind: 'hash.files', title: 'Fingerprint laptop', params: { placeId: 'laptop' } },
      { id: 5, kind: 'settings.saveToDrive', title: 'Save settings', params: {} },
      { id: 6, kind: 'copy.toLocal', title: 'Back up', params: { planId: 'x', targetPlaceId: 'aaaa-t7' } },
    ]);
    expect(jobsUsing(jobs, T7).map((j) => j.id)).toEqual([1, 3, 5, 6]);
  });
});

describe('what Windows says', () => {
  it('names the program from a Kernel-PnP 225 message', () => {
    expect(programFromVeto(VETO_OWN)).toBe('BackupHub.exe');
    expect(blockingProgram(`nothing here\n${VETO_OWN}`)).toBe('BackupHub.exe');
    expect(programFromVeto('something else')).toBeNull();
  });

  it('says Windows itself when the blocker is System (process 4), not a program name', () => {
    const veto = 'The application System with process id 4 stopped the removal or ejection for the device USB VID_04E8.';
    expect(programFromVeto(veto)).toBe('System');
    const line = blockedLine('T7', programFromVeto(veto));
    expect(line).toContain('Windows itself is still using the drive (for example writing cached data or scanning it). Wait a minute and try again.');
    expect(line).not.toContain('The program');
  });

  it('builds the script only for a drive letter', () => {
    expect(ejectScript('F:')).toContain("ParseName('F:\\')");
    expect(() => ejectScript("F:'; Remove-Item x")).toThrow();
  });
});

describe('Eject', () => {
  it('ejects an idle drive and says it can be unplugged', async () => {
    const { svc, scripts } = service({ jobs: jobsOf([]) });
    const result = await svc.eject(T7.placeId, false);
    expect(result).toEqual({ ok: true, message: 'T7 can be unplugged now.' });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("InvokeVerb('Eject')");
  });

  it('asks first when a job uses the drive, and stops nothing until the person says yes', async () => {
    const jobs = jobsOf([{ id: 9, kind: 'hash.files', title: 'Fingerprint files on T7', params: { placeId: 'aaaa-t7' } }]);
    const { svc, scripts } = service({ jobs });
    const asked = await svc.eject(T7.placeId, false);
    expect(asked).toMatchObject({ ok: false, needsConfirm: true, jobs: [{ id: 9, title: 'Fingerprint files on T7' }] });
    expect(jobs.cancelled).toEqual([]);
    expect(scripts).toEqual([]);
    const done = await svc.eject(T7.placeId, true);
    expect(done.ok).toBe(true);
    expect(jobs.cancelled).toEqual([9]);
  });

  it('when Windows refuses, says so plainly and names the program from the log; nothing is forced', async () => {
    const { svc, scripts } = service({
      jobs: jobsOf([]),
      stillThere: async () => true,
      powershell: async (script) => (script.includes('InvokeVerb') ? 'SENT' : VETO_OTHER),
    });
    const result = await svc.eject(T7.placeId, false);
    expect(result).toMatchObject({ ok: false, blockedBy: 'Backup.exe' });
    expect(result.message).toMatch(/Windows did not let T7 go\. The program Backup\.exe still has it open\. Nothing was forced/);
    expect(scripts.some((s) => /Dismount|Remove-|Format/i.test(s))).toBe(false);
  });

  it('names Backup Hub itself when the log says so, and copes with an unreadable log', async () => {
    const own = service({
      jobs: jobsOf([]),
      stillThere: async () => true,
      powershell: async (script) => (script.includes('InvokeVerb') ? 'SENT' : VETO_OWN),
    });
    expect((await own.svc.eject(T7.placeId, false)).message).toMatch(/Backup Hub itself still has it open/);
    const blind = service({
      jobs: jobsOf([]),
      stillThere: async () => true,
      powershell: async (script) => {
        if (script.includes('InvokeVerb')) return 'SENT';
        throw new Error('no access to the log');
      },
    });
    expect(await blind.svc.eject(T7.placeId, false)).toMatchObject({ ok: false, blockedBy: null });
  });

  it('says plainly when the drive is gone or Windows has no Eject for it', async () => {
    const gone = service({ jobs: jobsOf([]), drives: () => [] });
    expect((await gone.svc.eject('nope', false)).message).toMatch(/not plugged in any more/);
    const none = service({ jobs: jobsOf([]), powershell: async () => 'NOITEM' });
    expect((await none.svc.eject(T7.placeId, false)).message).toMatch(/Windows has no Eject for T7/);
  });
});
