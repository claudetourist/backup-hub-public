import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? tsxFiles(full) : name.endsWith('.tsx') ? [full] : [];
  });
}

/** Every opening tag of `tag` in the source, from `<tag` to its closing `>` (attributes may span lines; `=>` inside is skipped). */
function tags(source: string, tag: string, withIndex = false): string[] {
  const found: string[] = [];
  const re = new RegExp(`<${tag}(?=[ \t\r\n>/])`, 'g');
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 0;
    let i = m.index;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0 && source[i - 1] !== '=') break;
    }
    found.push(withIndex ? `${m.index}:${source.slice(m.index, i + 1)}` : source.slice(m.index, i + 1));
  }
  return found;
}

const files = tsxFiles(__dirname).filter((f) => !f.includes('DevGallery'));

describe('screen reader and keyboard basics (static checks of the markup)', () => {
  it('every input, select and textarea has a name: aria-label, aria-labelledby or an id a label points at', () => {
    const bad: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const tag of ['input', 'select', 'textarea']) {
        for (const indexed of tags(source, tag, true)) {
          const at = Number(indexed.slice(0, indexed.indexOf(':')));
          const t = indexed.slice(indexed.indexOf(':') + 1);
          if (/type="(hidden)"/.test(t)) continue;
          if (/aria-label=|aria-labelledby=|\sid=/.test(t)) continue;
          // Inside a <label> ... </label> the text of the label names it.
          const before = source.slice(0, at);
          if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
          bad.push(`${file.replace(__dirname, '')}: ${t.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('every decorative svg is hidden from screen readers or has a role', () => {
    const bad: string[] = [];
    for (const file of files) {
      for (const t of tags(readFileSync(file, 'utf8'), 'svg')) {
        if (!/aria-hidden=|role=|aria-label=/.test(t)) bad.push(`${file.replace(__dirname, '')}: ${t.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every image has alt text', () => {
    const bad: string[] = [];
    for (const file of files) for (const t of tags(readFileSync(file, 'utf8'), 'img')) if (!/\salt=/.test(t)) bad.push(file);
    expect(bad).toEqual([]);
  });

  it('every table has a caption or a name', () => {
    const bad: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const t of tags(source, 'table')) if (!/aria-label=|aria-labelledby=/.test(t) && !source.includes('<caption')) bad.push(`${file.replace(__dirname, '')}: ${t.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
    expect(bad).toEqual([]);
  });

  it('the page has a skip link, and focus rings are not switched off for keyboard users', () => {
    const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
    expect(app).toContain('skip-link');
    const css = readFileSync(join(__dirname, 'app.css'), 'utf8');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('.skip-link');
  });
});
