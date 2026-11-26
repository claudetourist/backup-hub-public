/**
 * Watching the two drives of a pair during a mirror job (copy or check): which drives are plugged in, the laptop sleeping, USB trouble (Windows
 * events 153 / 129), and waiting for the person's Continue. One place, so the copy and the check pause and carry on the same way.
 */
import type { MirrorCtx, MirrorDeps, MirrorDrive, MirrorPair } from './mirrorTypes';

export class DriveWatch {
  private readonly drives = new Map<number, { src: MirrorDrive; dst: MirrorDrive }>();
  private lastWake: number;
  private lastUsb = Number.NEGATIVE_INFINITY;
  private usbSince: number;
  private readonly now: () => number;

  /** `noun` is the word in the plain messages ("the copy carries on where it stopped"); `onUsbPause` counts a pause for the report. */
  constructor(
    private readonly deps: MirrorDeps,
    private readonly ctx: MirrorCtx,
    private readonly pairs: readonly MirrorPair[],
    private readonly noun: 'copy' | 'check',
    private readonly onUsbPause: () => void,
  ) {
    this.now = deps.now ?? Date.now;
    this.lastWake = deps.wakeCount?.() ?? 0;
    this.usbSince = this.now();
  }

  private get carriesOn(): string {
    return `Nothing is lost; the ${this.noun} carries on where it stopped.`;
  }

  /** Counts every time the drives were forgotten and found again (a sleep, an unplug, USB trouble): reads started before are not trusted. */
  round = 0;

  /** The drives of a pair when they are already connected, else null (never waits for anything). */
  connected(b: number): { src: MirrorDrive; dst: MirrorDrive } | null {
    return this.drives.get(b) ?? null;
  }

  async drivesOf(b: number): Promise<{ src: MirrorDrive; dst: MirrorDrive }> {
    const have = this.drives.get(b);
    if (have) return have;
    const pair = this.pairs[b]!;
    for (;;) {
      const found = await this.deps.drivesFor(pair.srcPlaceId, pair.dstPlaceId);
      if (found.src && found.dst) {
        const both = { src: found.src, dst: found.dst };
        this.drives.set(b, both);
        return both;
      }
      const message = !found.src
        ? `Plug in the ${pair.srcLabel} to ${this.noun === 'copy' ? `bring the ${pair.dstLabel} up to date` : `check the old copies on the ${pair.dstLabel}`}, then press Continue. ${this.carriesOn}`
        : `${pair.dstLabel} is not plugged in. Plug it in, then press Continue. ${this.carriesOn}`;
      await this.ctx.needsYou(message, ['Continue']);
    }
  }

  /** The laptop slept since the last look: both drives are looked at again before going on. */
  async afterSleep(b: number): Promise<void> {
    if ((this.deps.wakeCount?.() ?? 0) === this.lastWake) return;
    this.lastWake = this.deps.wakeCount?.() ?? 0;
    this.ctx.log('info', 'The laptop slept. Looking at both drives again before going on.');
    await this.reconnect(b, 'sleep');
  }

  /** Like an unplug: forget the drives, wait for the person when one is missing, and go on. */
  async reconnect(b: number, why: 'sleep' | 'drive'): Promise<void> {
    this.round += 1;
    this.drives.delete(b);
    if (why === 'drive') {
      const pair = this.pairs[b]!;
      const found = await this.deps.drivesFor(pair.srcPlaceId, pair.dstPlaceId);
      const gone = !found.src ? pair.srcLabel : !found.dst ? pair.dstLabel : null;
      const text = gone !== null ? `${gone} was unplugged or stopped answering. Plug it in` : 'A drive stopped answering. Plug it back in';
      await this.ctx.needsYou(`${text} (straight into the laptop, not a hub), then press Continue. ${this.carriesOn}`, ['Continue']);
      this.usbSince = this.now();
    }
    await this.drivesOf(b);
  }

  /** Windows events 153 / 129 for either drive since the last Continue: pause with a plain message. Read now and then (the log read is a PowerShell call). */
  async usbCheck(b: number, force: boolean): Promise<void> {
    const check = this.deps.usbTrouble;
    if (!check) return;
    const t = this.now();
    if (!force && t - this.lastUsb < (this.deps.usbEveryMs ?? 60_000)) return;
    this.lastUsb = t;
    const pair = this.pairs[b]!;
    for (const [placeId, label] of [[pair.dstPlaceId, pair.dstLabel], [pair.srcPlaceId, pair.srcLabel]] as const) {
      if (!(await check(placeId, this.usbSince))) continue;
      this.onUsbPause();
      await this.ctx.needsYou(`${label} had a USB problem. Plug it straight into the laptop, not a hub, then press Continue. ${this.carriesOn}`, ['Continue']);
      this.usbSince = this.now();
      this.round += 1;
      this.drives.delete(b);
      await this.drivesOf(b);
      return;
    }
  }

  async stillThere(b: number): Promise<boolean> {
    const pair = this.pairs[b]!;
    const found = await this.deps.drivesFor(pair.srcPlaceId, pair.dstPlaceId);
    return found.src !== null && found.dst !== null;
  }
}
