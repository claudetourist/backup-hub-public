import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlaceView } from '../../shared/places';
import { driveStripe } from './devicesModel';
import { PlaceCard } from './PlaceCard';
import { SafeToUnplugNote, SafeUnplugButton, safeUnplugLine } from './SafeUnplug';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const NOW = new Date(2026, 10, 26, 12).getTime();
const phone = (over: Partial<PlaceView> = {}): PlaceView =>
  ({ id: 'ph', kind: 'phone', label: 'POCO F4', status: 'connected', capacityBytes: null, freeBytes: null, lastLookedAt: null, lastConnectedAt: null, listing: 'idle', problem: null, ...over }) as PlaceView;

describe('Safe to unplug for phones', () => {
  it('a connected phone card offers the button', () => {
    const html = render(h(PlaceCard, { place: phone(), now: NOW }));
    expect(html).toContain('Safe to unplug');
    expect(html).not.toContain('Use the phone again');
  });

  it('after it was pressed the card says so and offers to use the phone again (the pill says it too)', () => {
    const html = render(h(PlaceCard, { place: phone({ status: 'disconnected', safeToUnplug: true }), now: NOW }));
    expect(html).toContain('Safe to unplug the phone');
    expect(html).toContain('Use the phone again');
    expect(html).not.toContain('Not connected');
    expect(driveStripe({ status: 'disconnected', capacityBytes: null, freeBytes: null, safeToUnplug: true })).toEqual({ tone: 'ok', word: 'Safe to unplug' });
  });

  it('a phone that is not plugged in has neither', () => {
    const html = render(h(PlaceCard, { place: phone({ status: 'disconnected' }), now: NOW }));
    expect(html).not.toContain('Safe to unplug');
    expect(html).toContain('Not connected');
  });

  it('drives and the laptop do not get it (they have Eject)', () => {
    expect(render(h(PlaceCard, { place: phone({ kind: 'drive', label: 'T7' }), now: NOW }))).not.toContain('Safe to unplug');
  });

  it('the button and the note on their own, and the line after the press says which job is in the way', () => {
    expect(render(h(SafeUnplugButton, {}))).toContain('Safe to unplug');
    expect(render(h(SafeToUnplugNote, {}))).toContain('Safe to unplug the phone');
    expect(safeUnplugLine({ ok: true, message: 'Safe to unplug the phone' })).toBe('Safe to unplug the phone. Plug it in again when you want to use it.');
    const busy = safeUnplugLine({ ok: false, message: '"Back up Poco F4" is still using the phone. Wait until it has finished.', busyJob: 'Back up Poco F4' });
    expect(busy).toContain('Back up Poco F4');
  });
});
