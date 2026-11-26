/**
 * Per-key emit throttle: the first push goes out immediately, later pushes inside the interval
 * are merged and the latest one is sent when the interval ends (so the final value is never lost).
 * At 250 ms this gives at most 4 events per second per key.
 */
export interface ThrottleClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

interface Slot<V> {
  lastEmit: number;
  pending: { value: V } | null;
  timer: unknown;
}

export class KeyedThrottle<K, V> {
  private readonly slots = new Map<K, Slot<V>>();

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (key: K, value: V) => void,
    private readonly clock: ThrottleClock = realClock,
  ) {}

  push(key: K, value: V): void {
    const now = this.clock.now();
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { lastEmit: Number.NEGATIVE_INFINITY, pending: null, timer: null };
      this.slots.set(key, slot);
    }
    const wait = slot.lastEmit + this.intervalMs - now;
    if (wait <= 0 && slot.timer === null) {
      slot.lastEmit = now;
      this.emit(key, value);
      return;
    }
    slot.pending = { value };
    if (slot.timer === null) {
      slot.timer = this.clock.setTimer(() => this.fire(key), Math.max(0, wait));
    }
  }

  private fire(key: K): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.timer = null;
    const pending = slot.pending;
    slot.pending = null;
    if (!pending) return;
    slot.lastEmit = this.clock.now();
    this.emit(key, pending.value);
  }

  /** Forget a key and cancel anything waiting (used when a state change supersedes it). */
  drop(key: K): void {
    const slot = this.slots.get(key);
    if (slot && slot.timer !== null) this.clock.clearTimer(slot.timer);
    this.slots.delete(key);
  }

  dispose(): void {
    for (const key of this.slots.keys()) this.drop(key);
  }
}
