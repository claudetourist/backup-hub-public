import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { transformSync } from 'esbuild';
import { parseAst } from 'rollup/parseAst';
import { describe, expect, it } from 'vitest';

/**
 * Plain words (PLANS-DESIGN section 8): the window never shows the insider words "listing", "look again", "looked",
 * "fingerprint", "ledger", "catalog", "Jobs screen" or "Sources". Only the TEXT the person can read is checked: every string,
 * template and JSX text after TypeScript and JSX are compiled away (so comments, imports, identifiers and type names are never
 * looked at). Skipped: one-word code tokens such as 'listing' or 'sources.google', property keys, SQL, arguments of log.* calls
 * (the log file is not the window), migrations, tests, test helpers, and the dev-only files (gallery, mock bridge).
 *
 * Three roots: the renderer (all text), and src/main + src/shared (job titles, job messages, JobFailure text, warnings, notes,
 * IPC answers: everything that can reach the window). In main and shared "listed" and "List now" are banned too.
 */

export const BANNED_RENDERER = /\b(listings?|look again|looked|fingerprint\w*|ledger|catalog\w*|jobs screen|sources|destinations?)\b/i;
export const BANNED_MAIN = /\b(listings?|listed|list now|list the place|look(ed)? again|looked|fingerprint\w*|ledger|catalog\w*|jobs screen|sources|collections screen|destinations?)\b/i;

const RENDERER = __dirname;
const SRC = join(__dirname, '..');
const DEV_ONLY = new Set(['dev', 'screens/DevGallery.tsx']);

function sourceFiles(root: string, dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = relative(root, full).replaceAll('\\', '/');
    if (DEV_ONLY.has(rel) || name === 'migrations') return [];
    if (statSync(full).isDirectory()) return sourceFiles(root, full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('testUtil.ts') && !name.endsWith('.d.ts') ? [full] : [];
  });
}

/** A one-word token such as 'listing', 'sources.google' or 'backuphub.sources.focus' is code, not text for the person. */
const isCodeToken = (text: string): boolean => /^[a-z][\w.:#/-]*$/.test(text.trim());
const isSql = (text: string): boolean => /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|PRAGMA)\b/.test(text);
const LOG_OBJECTS = new Set(['log', 'logger', 'console']);

type Node = { type?: string; [key: string]: unknown };

/** Is this the call `log.info(...)`, `this.deps.log?.warn(...)`, `console.error(...)`? Its text goes to the log file only. */
function isLogCall(node: Node): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as Node | undefined;
  if (callee?.type !== 'MemberExpression') return false;
  const object = callee.object as Node | undefined;
  const name = (object?.name as string | undefined) ?? ((object?.property as Node | undefined)?.name as string | undefined);
  return name !== undefined && LOG_OBJECTS.has(name);
}

/** Every piece of display text in a file (as compiled), in order. */
export function displayStrings(fileName: string, code: string): string[] {
  const js = transformSync(code, { loader: fileName.endsWith('x') ? 'tsx' : 'ts', jsx: 'automatic', target: 'esnext', sourcefile: fileName }).code;
  const found: string[] = [];
  const keep = (text: string): boolean => text.trim() !== '' && !isCodeToken(text) && !isSql(text);
  const visit = (value: unknown, skipKeys: readonly string[]): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, []);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Node;
    if (isLogCall(node)) return;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (keep(node.value)) found.push(node.value);
      return;
    }
    if (node.type === 'TemplateLiteral') {
      // SQL in a template is judged as a whole (its text pieces joined), not piece by piece.
      const quasis = (node.quasis as Node[]).map((q) => (q.value as { cooked?: string | null }).cooked ?? '');
      if (isSql(quasis.join(' '))) return;
    }
    if (node.type === 'TemplateElement') {
      const cooked = (node.value as { cooked?: string | null } | undefined)?.cooked;
      if (cooked && keep(cooked)) found.push(cooked);
      return;
    }
    const skip = node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration' ? ['source'] : node.type === 'Property' && node.computed === false ? ['key'] : skipKeys;
    for (const [key, child] of Object.entries(node)) if (!skip.includes(key)) visit(child, []);
  };
  visit(parseAst(js), []);
  return found;
}

function problemsIn(root: string, banned: RegExp): string[] {
  const problems: string[] = [];
  for (const file of sourceFiles(root, root)) {
    for (const text of displayStrings(file, readFileSync(file, 'utf8'))) {
      const match = banned.exec(text);
      if (match) problems.push(`${relative(SRC, file).replaceAll('\\', '/')}: "${match[0]}" in "${text.trim().slice(0, 80)}"`);
    }
  }
  return problems;
}

describe('plain words in what the window shows', () => {
  it('finds display text and ignores code (the check itself)', () => {
    const code = [
      "import { lookAgain } from './listing/ledger';",
      '// the ledger and the catalog are named here in a comment',
      "const state = 'listing';",
      "const key = 'backuphub.sources.focus';",
      "type Mode = 'fingerprint' | 'ledger';",
      "const table = { catalog: 1, 'sources': 2 };",
      'const a = window.backupHub.listing.lookAgain(id);',
      "const bad = 'Look again first';",
      'const tpl = `Watch it on the Jobs screen ${n}`;',
      'const el = <p>Open Sources</p>;',
      'const label = <button aria-label="Sources">Go</button>;',
      "log.info('Listed 5 files in the catalog');",
      'deps.log?.warn(`fingerprint of ${x}`);',
      'db.prepare(`SELECT last_looked_at FROM places WHERE x = ?`);',
      "const sql = 'UPDATE places SET last_looked_at = ?';",
      "ctx.warn('The file was looked at too early');",
    ].join('\n');
    const hits = displayStrings('x.tsx', code).filter((text) => BANNED_MAIN.test(text));
    expect(hits).toEqual(['Look again first', 'Watch it on the Jobs screen ', 'Open Sources', 'Sources', 'The file was looked at too early']);
  });

  it('shows none of the insider words in any renderer text', () => {
    const problems = problemsIn(RENDERER, BANNED_RENDERER);
    expect(problems, `Use the plain words (see PLANS-DESIGN section 8):\n${problems.join('\n')}`).toEqual([]);
  }, 60_000);

  it('reads the new shell and kit files too (they are not skipped), and each has words to check', () => {
    const scanned = new Set(sourceFiles(RENDERER, RENDERER).map((file) => relative(RENDERER, file).replaceAll('\\', '/')));
    const mustRead = [
      'navConfig.ts',
      'App.tsx',
      'components/Rail.tsx',
      'components/backupStatus.ts',
      'components/kindChips.ts',
      'components/StateView.tsx',
      'components/PreviewList.tsx',
      'components/previewModel.ts',
      'components/ProgressPanel.tsx',
      'components/progressModel.ts',
      'components/Report.tsx',
      'components/Drawer.tsx',
      'components/Toast.tsx',
      'screens/Home.tsx',
      'screens/Devices.tsx',
      'screens/Activity.tsx',
    ];
    for (const name of mustRead) {
      expect(scanned.has(name), `${name} is scanned`).toBe(true);
      expect(displayStrings(name, readFileSync(join(RENDERER, name), 'utf8')).length, `${name} has text`).toBeGreaterThan(0);
    }
  });

  it('shows none of them in job titles, job messages, warnings and answers made by main and shared', () => {
    const problems = [...problemsIn(join(SRC, 'main'), BANNED_MAIN), ...problemsIn(join(SRC, 'shared'), BANNED_MAIN)];
    expect(problems, `Use the plain words (see PLANS-DESIGN section 8):\n${problems.join('\n')}`).toEqual([]);
  }, 60_000);
});
