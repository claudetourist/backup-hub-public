import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDashed, STATUS_ICONS, STATUS_TONES } from './components/backupStatus';
import { KIND_CHIPS, KIND_CHIP_IDS } from './components/kindChips';
import { closestPair, contrast, type Vision } from './colorTestUtil';

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

type Theme = Record<string, string>;

function parseVars(block: string): Theme {
  const vars: Theme = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    vars[match[1]!] = match[2]!.toLowerCase();
  }
  return vars;
}

/** Body of the first rule whose selector starts with `selector`, braces balanced. */
function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces for ${selector}`);
}

/** The tint shares (--tint-card ...) of a block, as 0..1. */
function parseTints(block: string): Record<string, number> {
  const tints: Record<string, number> = {};
  for (const match of block.matchAll(/(--tint-[a-z]+):\s*(\d+)%\s*;/g)) tints[match[1]!] = Number(match[2]) / 100;
  return tints;
}

/** The colour CSS color-mix(in srgb, top share%, base) gives, as a hex string (both colours opaque). */
function mix(top: string, base: string, share: number): string {
  const channel = (i: number): string => {
    const a = parseInt(top.slice(i, i + 2), 16);
    const b = parseInt(base.slice(i, i + 2), 16);
    return Math.round(a * share + b * (1 - share)).toString(16).padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

const light = parseVars(ruleBody(css, ':root,'));
const darkMedia = parseVars(ruleBody(css, ':root:not([data-theme=\'light\'])'));
const darkAttr = parseVars(ruleBody(css, ':root[data-theme=\'dark\']'));
const dark: Theme = { ...light, ...darkAttr };
const lightTints = parseTints(ruleBody(css, ':root,'));
const darkTints = { ...lightTints, ...parseTints(ruleBody(css, ':root[data-theme=\'dark\']')) };

const STATUSES = ['ok', 'warn', 'crit', 'amber', 'info', 'neutral', 'offline'] as const;
/** One colour family per file kind family (Search, Jobs). */
const KIND_FAMILIES = [...new Set(['photos', 'videos', 'audio', 'documents', 'archives', 'google-docs', 'other', ...KIND_CHIP_IDS])];
const CATEGORIES = ['phone', 'laptop', 'onedrive', 'drive', 'google', 'person'] as const;
const GROUNDS = ['--color-ground', '--color-surface', '--color-surface-alt'] as const;

// [foreground token, background token, minimum ratio]
function textPairs(): [string, string, number][] {
  const pairs: [string, string, number][] = [];
  for (const bg of GROUNDS) {
    for (const fg of ['--color-ink', '--color-ink-soft', '--color-muted', '--color-accent']) pairs.push([fg, bg, 4.5]);
    for (const status of STATUSES) pairs.push([`--status-${status}-ink`, bg, 4.5]);
  }
  pairs.push(['--color-accent', '--color-accent-soft', 4.5]);
  pairs.push(['--color-on-accent', '--color-accent', 4.5]);
  pairs.push(['--color-on-accent', '--color-accent-strong', 4.5]);
  pairs.push(['--status-crit-on', '--status-crit', 4.5]);
  pairs.push(['--color-ink', '--color-accent-soft', 4.5]);
  for (const status of STATUSES) {
    pairs.push([`--status-${status}-ink`, `--status-${status}-bg`, 4.5]);
    // Status marks (stripes, dots, bar fills) are graphics: 3:1 against the surface.
    pairs.push([`--status-${status}`, '--color-surface', 3]);
  }
  pairs.push(['--color-accent', '--color-surface', 3]);
  for (const family of KIND_FAMILIES) {
    for (const bg of GROUNDS) pairs.push([`--kind-${family}-ink`, bg, 4.5]);
    pairs.push([`--kind-${family}-ink`, `--kind-${family}-bg`, 4.5]);
    pairs.push([`--kind-${family}`, '--color-surface', 3]);
    pairs.push([`--kind-${family}`, `--kind-${family}-bg`, 3]);
  }
  for (const cat of CATEGORIES) {
    for (const bg of GROUNDS) pairs.push([`--cat-${cat}-ink`, bg, 4.5]);
    pairs.push([`--cat-${cat}-ink`, `--cat-${cat}-bg`, 4.5]);
    pairs.push([`--cat-${cat}`, '--color-surface', 3]);
    pairs.push([`--cat-${cat}`, `--cat-${cat}-bg`, 3]);
  }
  return pairs;
}

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme contrast', (_name, theme) => {
  it.each(textPairs())('%s on %s is at least %s:1', (fg, bg, min) => {
    const fgHex = theme[fg];
    const bgHex = theme[bg];
    expect(fgHex, `${fg} defined`).toBeDefined();
    expect(bgHex, `${bg} defined`).toBeDefined();
    expect(contrast(fgHex!, bgHex!)).toBeGreaterThanOrEqual(min);
  });
});

describe('kind colours', () => {
  it('every family has distinct dot colours in both themes', () => {
    for (const theme of [light, dark]) {
      const dots = KIND_FAMILIES.map((f) => theme[`--kind-${f}`]);
      expect(new Set(dots).size).toBe(KIND_FAMILIES.length);
    }
  });
});

describe('category colours', () => {
  it('the six categories have distinct marks in both themes', () => {
    for (const theme of [light, dark]) {
      expect(new Set(CATEGORIES.map((c) => theme[`--cat-${c}`])).size).toBe(CATEGORIES.length);
    }
  });
});

describe('dark theme blocks', () => {
  it('system-dark and forced-dark define identical values', () => {
    expect(darkMedia).toEqual(darkAttr);
  });
  it('overrides every colour the light theme defines', () => {
    expect(Object.keys(darkAttr).toSorted()).toEqual(Object.keys(light).toSorted());
  });
});

/** The marks of the five backup statuses and the nine kinds, per theme, for the colour-blind checks. */
const VISIONS: readonly Vision[] = ['protan', 'deutan'];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme: the five statuses and the nine kinds can be told apart', (_name, theme) => {
  const statusMarks = (): Record<string, string> => Object.fromEntries(Object.values(STATUS_TONES).map((tone) => [tone, theme[`--status-${tone}`]!]));
  const kindMarks = (): Record<string, string> => Object.fromEntries(KIND_CHIP_IDS.map((id) => [id, theme[`--kind-${id}`]!]));

  it.each(VISIONS)('status colours differ clearly for %s vision (grey and the dashed grey are told apart by shape, below)', (vision) => {
    const marks = statusMarks();
    // "Never backed up" (grey) and "Not connected" (grey, dashed) are the same family on purpose: they differ by icon, word and dashed outline.
    const { offline, ...withoutOffline } = marks;
    const found = closestPair(withoutOffline, vision);
    expect(found.distance, `closest pair ${found.pair.join(' / ')}`).toBeGreaterThanOrEqual(12);
    const offlineVersus = closestPair({ offline: offline!, ok: marks.ok!, amber: marks.amber!, crit: marks.crit! }, vision);
    expect(offlineVersus.distance, `closest pair ${offlineVersus.pair.join(' / ')}`).toBeGreaterThanOrEqual(12);
  });

  it.each(VISIONS)('kind colours differ clearly for %s vision', (vision) => {
    const found = closestPair(kindMarks(), vision);
    expect(found.distance, `closest pair ${found.pair.join(' / ')}`).toBeGreaterThanOrEqual(12);
  });

  it('kind colours differ for normal vision too', () => {
    const found = closestPair(kindMarks(), 'normal');
    expect(found.distance, `closest pair ${found.pair.join(' / ')}`).toBeGreaterThanOrEqual(15);
  });
});

describe('colour is never the only signal', () => {
  it('each of the five statuses has its own icon, and only "Not connected" is dashed', () => {
    expect(new Set(Object.values(STATUS_ICONS)).size).toBe(5);
    expect(Object.keys(STATUS_ICONS).filter((s) => isDashed(s as keyof typeof STATUS_ICONS))).toEqual(['not-connected']);
  });
  it('each of the nine kinds has its own icon and word', () => {
    expect(KIND_CHIPS).toHaveLength(9);
    expect(new Set(KIND_CHIPS.map((k) => k.icon)).size).toBe(9);
    expect(new Set(KIND_CHIPS.map((k) => k.label)).size).toBe(9);
  });
});

describe('tints: text stays readable on every tinted background', () => {
  it('the dark blocks agree on the tint shares, and dark tints are stronger than light ones', () => {
    expect(parseTints(ruleBody(css, ":root:not([data-theme='light'])"))).toEqual(parseTints(ruleBody(css, ":root[data-theme='dark']")));
    for (const name of ['--tint-card', '--tint-wash', '--tint-strong']) {
      expect(lightTints[name], name).toBeDefined();
      expect(darkTints[name]!, name).toBeGreaterThan(lightTints[name]!);
    }
    for (const tints of [lightTints, darkTints]) expect(tints['--tint-card']! < tints['--tint-wash']! && tints['--tint-wash']! < tints['--tint-strong']!).toBe(true);
  });

  describe.each([
    ['light', light, lightTints],
    ['dark', dark, darkTints],
  ] as const)('%s theme', (_name, theme, tints) => {
    const marks = [...CATEGORIES.map((c) => `--cat-${c}`), '--status-ok', '--status-warn', '--status-crit', '--status-amber', '--status-info', '--status-neutral', '--color-accent'];
    const textOn = (bg: string, texts: readonly string[], min = 4.5): void => {
      for (const text of texts) expect(contrast(theme[text]!, bg), `${text} on ${bg}`).toBeGreaterThanOrEqual(min);
    };

    it('cards, panel heads, rows and the page glow (card and wash tints, on the surface and on the ground): ink, soft ink and muted text', () => {
      for (const mark of marks) {
        for (const share of ['--tint-card', '--tint-wash']) {
          for (const ground of ['--color-surface', '--color-ground', '--color-surface-alt']) textOn(mix(theme[mark]!, theme[ground]!, tints[share]!), ['--color-ink', '--color-ink-soft', '--color-muted'] as const);
        }
      }
    });

    it('banner, active sidebar item and selected settings group (strong tint): ink text, also with the -ink marks of the sidebar', () => {
      for (const mark of [...marks, ...CATEGORIES.map((c) => `--cat-${c}-ink`)]) textOn(mix(theme[mark]!, theme['--color-surface']!, tints['--tint-strong']!), ['--color-ink', '--color-ink-soft'] as const);
    });

    it('table header rows (accent tint on the alt surface) and the sidebar gradient (brand ends on the surface)', () => {
      textOn(mix(theme['--color-accent']!, theme['--color-surface-alt']!, tints['--tint-wash']!), ['--color-ink', '--color-ink-soft'] as const);
      textOn(mix(theme['--color-accent']!, theme['--color-surface']!, tints['--tint-wash']!), ['--color-ink', '--color-ink-soft', '--color-muted'] as const);
      textOn(mix(theme['--cat-phone']!, theme['--color-surface']!, tints['--tint-card']!), ['--color-ink', '--color-ink-soft', '--color-muted'] as const);
    });

    it('the primary button: text on both ends of the gradient and on its middle (4.5:1), and the icon on every category tile (3:1)', () => {
      for (const from of ['--color-accent', '--color-accent-strong']) {
        textOn(theme['--brand-button-to']!, ['--color-on-accent'] as const);
        textOn(theme[from]!, ['--color-on-accent'] as const);
        textOn(mix(theme[from]!, theme['--brand-button-to']!, 0.5), ['--color-on-accent'] as const);
      }
      for (const cat of CATEGORIES) {
        textOn(theme[`--cat-${cat}`]!, ['--color-on-accent'] as const, 3);
        textOn(mix(theme[`--cat-${cat}`]!, theme['--color-ink']!, 0.7), ['--color-on-accent'] as const, 3);
      }
    });

    it('the Excluded pill (rose) and its outline are readable', () => {
      textOn(theme['--cat-person-bg']!, ['--cat-person-ink'] as const);
    });
  });
});
