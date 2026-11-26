/** A small seeded random generator (mulberry32): the same seed always gives the same scenario. */
export class Rng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A whole number in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from nothing');
    return items[this.int(items.length)]!;
  }

  /** Picks by weight: [['a', 3], ['b', 1]]. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((n, [, w]) => n + w, 0);
    let at = this.next() * total;
    for (const [item, w] of items) {
      at -= w;
      if (at < 0) return item;
    }
    return items[items.length - 1]![0];
  }
}
