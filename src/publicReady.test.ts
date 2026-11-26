import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Public-release guard (PLAN R6): the repository must hold no personal path, name, device serial, account or secret.
 * Two scans over the tracked folders: (1) program code (not tests, not the mock data used by the dev gallery) holds no
 * Windows user-profile path and no hard-coded personal location; (2) every text file holds none of the personal strings.
 * The personal words are kept only as SHA-256 hashes, so this file does not reveal them; every word of every file is hashed and compared.
 */
const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.vite', 'out', 'dist', 'coverage', '.devdata', '.claude']);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|html|css|yml|yaml|txt)$/i;

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (TEXT_EXT.test(entry.name) && entry.name !== 'package-lock.json') {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const rel = (f: string): string => path.relative(ROOT, f).split(path.sep).join('/');
const allFiles = walk(ROOT, []).filter((f) => rel(f) !== 'src/publicReady.test.ts');
const isTestOrMock = (r: string): boolean => /\.(test|testutil)\.tsx?$/.test(r) || r.startsWith('src/renderer/dev/') || r.endsWith('DevGallery.tsx');
const programFiles = allFiles.filter((f) => /\.tsx?$/.test(f) && rel(f).startsWith('src/') && !isTestOrMock(rel(f)));

/** SHA-256 of personal words (lower case), found as whole words split on anything that is not a letter or digit. */
const PERSONAL_WORDS = new Set([
  'c8bd73bfe9c5dd4ea7d4d5a7839864ccec2a20f2f78f19b85521248a0005cd91',
  '11bf66358a443a2069d859a355e9849c7205de4ece30857d007693c64aa0fc70',
  'a2c2789ab5ffaa88f84e43b0c83e0a0cd0e9e51bf2892ef21cf5de9fcc683e90',
  '8ec30a497496553a8d17db7173aa0cb04708481b69d5182497ae45079c1640f6',
  '22c6c46bac9d36ab336d930548d5130c87f655a667dde54ce44c0638dd71ba0d',
  '32a323665a2d5f5cf7c002c3ec6877ca0d149378e9e1da656e3d1dc458641dd0',
  'b459f5b1c7184faf4012d0881682e9547b00c4e7077d6cf726f7ca0091b52aee',
  'b35ae76d9ccccd2f3d17aa646dc9c6f4f42ec33733bda088d86daecf0833ac46',
]);
const PERSONAL: [string, RegExp][] = [
  ['a gmail address', /@gmail\.com/i],
  ['a real Google client secret or token', /(GOCSPX-[A-Za-z0-9_-]{24,}|ya29\.[A-Za-z0-9_-]{60,}|1\/\/0[A-Za-z0-9_-]{60,}|\d{9,}-[a-z0-9]{24,}\.apps\.googleusercontent\.com)/],
];
const hashWord = (w: string): string => createHash('sha256').update(w).digest('hex');
function personalWords(text: string): string[] {
  const hits = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && PERSONAL_WORDS.has(hashWord(w))) hits.add(w.slice(0, 2) + '...');
  return [...hits];
}

/** C:\Users\<name> in program code: only obviously generic names may appear (you, user, name, me, someone, a placeholder in angle brackets). */
const USER_PATH = /[A-Za-z]:(?:\\{1,4}|\/)Users(?:\\{1,4}|\/)([^\\/'"`\s)]+)/gi;
const GENERIC_USER = /^(.|you|user|name|me|someone|sample|other|test|alice|bob|example|public|default|%?username%?|<.*>|\$\{.*\}|\*|\.\.\.)$/i;

function userPathProblems(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(USER_PATH)) {
    const name = (m[1] ?? '').replace(/^\\+/, '');
    if (!GENERIC_USER.test(name)) found.push(m[0]);
  }
  return found;
}

describe('public release scan', () => {
  it('finds files to scan (guards against an empty scan passing)', () => {
    expect(allFiles.length).toBeGreaterThan(300);
    expect(programFiles.length).toBeGreaterThan(150);
  });

  it('program code names no user-profile folder, no fixed data folder and no personal adb location', () => {
    const problems: string[] = [];
    for (const f of programFiles) {
      const text = fs.readFileSync(f, 'utf8');
      for (const p of userPathProblems(text)) problems.push(`${rel(f)}: ${p}`);
      for (const bad of [/Downloads['"\\/]+platform-tools/i, /D:\\{1,2}BackupHub/i, /D:\\{1,2}MyData/i]) {
        const hit = bad.exec(text);
        if (hit) problems.push(`${rel(f)}: ${hit[0]}`);
      }
    }
    expect(problems, 'Make it a setting or an environment variable with a generic default:\n' + problems.join('\n')).toEqual([]);
  });

  it('no file holds a personal name, serial, account or a real secret', () => {
    const problems: string[] = [];
    for (const f of allFiles) {
      const text = fs.readFileSync(f, 'utf8');
      for (const [what, re] of PERSONAL) {
        const hit = re.exec(text);
        if (hit) problems.push(`${rel(f)}: ${what} (${hit[0].slice(0, 6)}...)`);
      }
      for (const w of personalWords(text)) problems.push(`${rel(f)}: a personal word (${w})`);
    }
    expect(problems.join('\n')).toBe('');
  });
});
