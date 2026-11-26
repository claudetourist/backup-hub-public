import { describe, expect, it } from 'vitest';
import { formatPauseEnd, isPauseOn, normalizePause, pauseBanner, pauseFromChoice, PAUSE_CHOICES } from './pause';

const at = (y: number, m: number, d: number, h: number, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

describe('pause rules', () => {
  it('offers 1 hour, until tomorrow and until I resume', () => {
    expect(PAUSE_CHOICES.map((c) => c.label)).toEqual(['1 hour', 'Until tomorrow', 'Until I resume']);
  });

  it('makes the state of each choice', () => {
    const now = at(2026, 11, 23, 13, 30);
    expect(pauseFromChoice('hour', now)).toEqual({ mode: 'until', until: now + 3_600_000 });
    expect(pauseFromChoice('tomorrow', now)).toEqual({ mode: 'until', until: at(2026, 11, 24, 8) });
    expect(pauseFromChoice('tomorrow', at(2026, 11, 23, 2))).toEqual({ mode: 'until', until: at(2026, 11, 24, 8) });
    expect(pauseFromChoice('manual', now)).toEqual({ mode: 'manual' });
    expect(pauseFromChoice('off', now)).toEqual({ mode: 'off' });
  });

  it('reads saved values: anything unusable or already over is off', () => {
    const now = 1000;
    expect(normalizePause({ mode: 'manual' }, now)).toEqual({ mode: 'manual' });
    expect(normalizePause({ mode: 'until', until: 5000 }, now)).toEqual({ mode: 'until', until: 5000 });
    for (const bad of [null, 3, 'x', {}, { mode: 'until' }, { mode: 'until', until: 500 }, { mode: 'until', until: Number.NaN }, { mode: 'weekly' }]) expect(normalizePause(bad, now)).toEqual({ mode: 'off' });
    expect(isPauseOn({ mode: 'off' })).toBe(false);
    expect(isPauseOn({ mode: 'manual' })).toBe(true);
  });

  it('says when it ends, as the banner reads', () => {
    const now = at(2026, 11, 23, 13, 30);
    expect(pauseBanner({ mode: 'off' }, now)).toBeNull();
    expect(pauseBanner({ mode: 'until', until: at(2026, 11, 23, 14, 30) }, now)).toBe('Everything is paused until 14:30');
    expect(pauseBanner({ mode: 'until', until: at(2026, 11, 24, 8) }, now)).toBe('Everything is paused until tomorrow 08:00');
    expect(pauseBanner({ mode: 'manual' }, now)).toBe('Everything is paused until you resume');
    expect(formatPauseEnd(at(2026, 11, 27, 9, 5), now)).toBe('27 Nov 09:05');
  });
});
