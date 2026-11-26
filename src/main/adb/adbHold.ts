/**
 * "Safe to unplug" for phones. Windows refuses to eject a phone while the adb server runs, and the app keeps adb warm by asking it which phones
 * are plugged in (Home, Backups and Devices polls). After the person pressed "Safe to unplug" the app lets go of adb and stops asking until the
 * phone is plugged in again, so Windows can eject it and nothing starts adb behind the person's back.
 *
 * The hold ends when: a phone job runs (the person is using the phone again), the person says so ("Use the phone again"), or the phone was seen
 * gone and then seen again (a USB probe, when one is given). Without a probe only the first two end it.
 */

/** Is the phone with this serial plugged into the PC right now? null = could not tell. Asks Windows, never adb. */
export type PhoneProbe = (serial: string) => Promise<boolean | null>;

/** The least time between two probes while a hold lasts. */
export const PROBE_EVERY_MS = 4000;

export interface HeldPhone {
  serial: string;
  name: string;
}

export class AdbHold {
  private phones: HeldPhone[] | null = null;
  private gone = new Set<string>();
  private lastProbeAt = 0;

  isHeld(): boolean {
    return this.phones !== null;
  }

  held(): readonly HeldPhone[] {
    return this.phones ?? [];
  }

  /** Starts the hold for these phones (the ones adb knew when it was let go). */
  hold(phones: readonly HeldPhone[]): void {
    this.phones = phones.map((p) => ({ ...p }));
    this.gone = new Set();
    this.lastProbeAt = 0;
  }

  release(): void {
    this.phones = null;
    this.gone = new Set();
  }

  /**
   * Looks (at most every PROBE_EVERY_MS) whether a held phone went away and came back. Returns true when the hold ended because a phone that was
   * seen gone is plugged in again.
   */
  async checkReplug(probe: PhoneProbe | undefined, now: number): Promise<boolean> {
    if (this.phones === null || probe === undefined || now - this.lastProbeAt < PROBE_EVERY_MS) return false;
    this.lastProbeAt = now;
    for (const p of this.phones) {
      let present: boolean | null;
      try {
        present = await probe(p.serial);
      } catch {
        present = null;
      }
      if (present === false) this.gone.add(p.serial);
      else if (present === true && this.gone.has(p.serial)) {
        this.release();
        return true;
      }
    }
    return false;
  }
}
