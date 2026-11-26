import { BATTERY_PAUSE_PERCENT } from '../../shared/fingerprint';

/**
 * How long to wait after reading `bytes` bytes in `elapsedMs` so the average stays at or below
 * `capBytesPerSec`. Zero or less means "no limit" and never waits.
 */
export function throttleDelayMs(bytes: number, elapsedMs: number, capBytesPerSec: number): number {
  if (!(capBytesPerSec > 0) || bytes <= 0) return 0;
  const shouldHaveTakenMs = (bytes / capBytesPerSec) * 1000;
  return Math.max(0, Math.ceil(shouldHaveTakenMs - elapsedMs));
}

/** Caps from this speed up (and "No limit", 0) let two big files be read at once, one per core. */
export const TWO_BIG_FILES_FROM_MB_PER_SEC = 250;

/** How many big files (over 64 MB) may be read at the same time under this cap (MB per second; 0 = no limit). */
export function bigFileLimit(megabytesPerSecond: number): number {
  return megabytesPerSecond === 0 || megabytesPerSecond >= TWO_BIG_FILES_FROM_MB_PER_SEC ? 2 : 1;
}

/** MB per second (the setting) as bytes per second. 1 MB = 1,000,000 bytes, like the rest of the app. */
export function capBytesPerSecond(megabytesPerSecond: number): number {
  return Math.round(megabytesPerSecond * 1_000_000);
}

export interface PowerReading {
  onBattery: boolean;
  /** 0 to 100, or null when the charge cannot be read (a desktop, or the query failed). */
  percent: number | null;
}

export type BatteryDecision = { pause: false } | { pause: true; message: string };

/**
 * Fingerprinting waits while the laptop runs on battery below 30%. When the charge is unknown it
 * keeps going: nothing here can tell that the battery is low.
 */
export function batteryDecision(reading: PowerReading, thresholdPercent: number = BATTERY_PAUSE_PERCENT): BatteryDecision {
  if (!reading.onBattery || reading.percent === null || reading.percent >= thresholdPercent) return { pause: false };
  return {
    pause: true,
    message: `Paused to save battery (${Math.round(reading.percent)}% left, not plugged in). It continues when you plug in or the battery is above ${thresholdPercent}%.`,
  };
}
