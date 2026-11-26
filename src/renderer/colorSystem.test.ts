import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_STATUSES, STATUS_TONES } from './components/backupStatus';
import { KIND_CHIP_IDS } from './components/kindChips';
import { KIND_FAMILIES } from './components/kindColors';
import { TONES } from './components/status';

const tokens = readFileSync(join(__dirname, 'tokens.css'), 'utf8');
const app = readFileSync(join(__dirname, 'app.css'), 'utf8');
const kit = readFileSync(join(__dirname, 'kit.css'), 'utf8');

/** Every custom property that is given a value anywhere in the two style sheets. */
const defined = new Set([...`${tokens}\n${app}\n${kit}`.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));

describe('the colour system is applied the same way everywhere', () => {
  it('every var(--x) the app style sheet uses is defined (no silent fallbacks to nothing)', () => {
    const used = [...`${app}\n${kit}`.matchAll(/var\((--[a-z0-9-]+)\s*(,[^)]*)?\)/g)].filter((m) => m[2] === undefined).map((m) => m[1]!);
    const missing = [...new Set(used)].filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('has a pill and a text colour for every tone, in one place', () => {
    for (const tone of TONES) {
      expect(app, `.pill--${tone}`).toContain(`.pill--${tone}`);
      expect(app, `.tone-text--${tone}`).toContain(`.tone-text--${tone}`);
    }
  });

  it('has a pill and a dot for every file kind family', () => {
    for (const family of KIND_FAMILIES) {
      expect(app, `.kind-pill--${family}`).toContain(`.kind-pill--${family}`);
      expect(app, `.kind-dot--${family}`).toContain(`.kind-dot--${family}`);
    }
  });

  it('has a style for each of the five statuses and each of the nine kinds (kit.css), using only defined tokens', () => {
    for (const status of BACKUP_STATUSES) expect(kit, status).toContain(`.status-pill--${STATUS_TONES[status]}`);
    expect(kit).toContain('.status-pill--dashed');
    for (const id of KIND_CHIP_IDS) {
      expect(kit, `.kind-chip--${id}`).toContain(`.kind-chip--${id} {`);
      for (const token of [`--kind-${id}`, `--kind-${id}-ink`, `--kind-${id}-bg`]) expect(defined.has(token), token).toBe(true);
    }
  });

  it('the kit style sheet draws no colour of its own (only tokens, white-on-nothing shadows and overlays)', () => {
    const literal = [...kit.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(literal).toEqual([]);
  });

  it('gives each source card tone a stripe in a status colour that the contrast test checks (3:1)', () => {
    for (const tone of ['ok', 'amber', 'warn', 'crit']) expect(app).toContain(`.source-card--${tone}`);
    for (const token of ['--status-ok', '--status-warn', '--status-crit']) expect(defined.has(token)).toBe(true);
  });
});
