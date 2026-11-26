import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotReadyPanel } from './NotReadyPanel';
import { PhoneCleanPanel } from './PhoneCleanPanel';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;

describe('Free up phone space while the second drive is not available', () => {
  it('shows the plain "Not ready yet" panel', () => {
    const html = render(h(NotReadyPanel));
    expect(html).toContain('Not ready yet');
    expect(html).toContain('The second drive (Seagate2TB) is not available, so nothing can be removed yet. Nothing is changed on your phone.');
  });

  it('hides the two buttons that make a plan, and keeps "Look for the phone"', () => {
    const blocked = render(h(PhoneCleanPanel, { onStarted: noop, blocked: true }));
    expect(blocked).not.toContain('See what can be removed');
    expect(blocked).not.toContain('See the other phone folders');
    expect(blocked).toContain('Look for the phone');
    const open = render(h(PhoneCleanPanel, { onStarted: noop }));
    expect(open).toContain('See what can be removed from the camera folder');
    expect(open).toContain('See the other phone folders');
  });
});
