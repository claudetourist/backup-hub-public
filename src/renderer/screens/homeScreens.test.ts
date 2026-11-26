import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HomeBackup } from './homeModel';
import { YourBackups } from './YourBackups';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const items: HomeBackup[] = [
  { id: 1, name: 'Poco F4', kind: 'phone', status: 'behind', lastLine: 'Last backup 17 Jul, 4 months ago', canBackUpNow: true, plugNote: null },
  { id: 2, name: 'Mom Samsung', kind: 'phone', status: 'never', lastLine: 'No backup yet', canBackUpNow: false, plugNote: 'Plug in Mom Samsung to back it up' },
  { id: 3, name: 'Docs', kind: 'laptop', status: 'up-to-date', lastLine: 'Last backup 23 Nov, yesterday', canBackUpNow: false, plugNote: null },
];

describe('Home: Your backups', () => {
  it('shows one row per backup with its status word and date', () => {
    const html = render(h(YourBackups, { items, failed: false, onBackUp: noop }));
    const plain = text(html);
    expect(plain).toContain('Your backups');
    for (const word of ['Behind', 'Never backed up', 'Up to date']) expect(plain).toContain(word);
    expect(plain).toContain('Last backup 17 Jul, 4 months ago');
    expect(html.match(/<li /g)).toHaveLength(3);
  });

  it('offers "Back up now" only for a phone that is plugged in, and tells a phone that is not to be plugged in', () => {
    const html = render(h(YourBackups, { items, failed: false, onBackUp: noop }));
    expect(html.match(/Back up now/g)).toHaveLength(1);
    expect(html).toContain('Plug in Mom Samsung to back it up');
  });

  it('says so when there is no backup, and when the list could not be read, and shows nothing while it is being read', () => {
    expect(render(h(YourBackups, { items: [], failed: false, onBackUp: noop }))).toContain('No backup is set up yet.');
    expect(render(h(YourBackups, { items: null, failed: true, onBackUp: noop }))).toContain('The list of backups could not be read.');
    expect(render(h(YourBackups, { items: null, failed: false, onBackUp: noop }))).not.toContain('<ul');
  });
});
