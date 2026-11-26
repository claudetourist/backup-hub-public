import { CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND } from '../../shared/cleanup';
import type { JobRecord } from '../../shared/jobs';
import type { PhoneEjectResult, PhoneStatus } from '../../shared/phone';
import type { AdbPort } from './adbPort';
import { releaseAdb } from './adbRelease';

export interface PhoneAdbJobs {
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
}

export interface PhoneAdbServiceDeps {
  adb: AdbPort;
  jobs: PhoneAdbJobs;
}

/**
 * The phone's cable connection for the clean-up screen: is adb there and which phones answer, and letting go of the phone
 * (adb kill-server) so Windows can eject it. It only reads; nothing on the phone is changed.
 */
export class PhoneAdbService {
  constructor(private readonly deps: PhoneAdbServiceDeps) {}

  private busy(): boolean {
    return this.deps.jobs.list({ states: ['queued', 'running', 'needs_you'] }).some((job) => job.kind === CLEAN_PHONE_JOB_KIND || job.kind === PUT_BACK_JOB_KIND || job.kind.startsWith('freeup.'));
  }

  async status(): Promise<PhoneStatus> {
    if (!this.deps.adb.available()) return { adb: 'missing' };
    try {
      return { adb: 'ready', devices: await this.deps.adb.devices() };
    } catch {
      return { adb: 'ready', devices: [] };
    } finally {
      await this.release();
    }
  }

  /** Lets go of the phone (adb kill-server) unless a phone job is using it right now. Never throws. */
  async release(): Promise<void> {
    try {
      if (!this.busy()) await releaseAdb(this.deps.adb);
    } catch {
      // Letting go is best effort.
    }
  }

  /** Lets the phone go: stops the adb server. */
  async eject(): Promise<PhoneEjectResult> {
    if (this.busy()) return { ok: false, message: 'A phone clean-up is running. Let it finish or stop it first.' };
    await releaseAdb(this.deps.adb);
    return { ok: true, message: 'Done. You can unplug the phone now.' };
  }
}
