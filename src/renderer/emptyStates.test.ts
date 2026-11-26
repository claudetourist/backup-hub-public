import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : name.endsWith('.tsx') ? [full] : [];
  });
}

describe('empty states', () => {
  const screens = sourceFiles(join(__dirname, 'screens')).filter((f) => !f.includes('DevGallery'));

  it('no screen shows a bare placeholder; every EmptyState says something', () => {
    for (const file of screens) {
      const text = readFileSync(file, 'utf8');
      expect(/<EmptyState\s*\/>/.test(text), `${file} has an EmptyState with no text`).toBe(false);
    }
  });

  it('no screen promises "coming in a later step"', () => {
    for (const file of screens) expect(readFileSync(file, 'utf8').toLowerCase(), file).not.toContain('coming in a later step');
  });
});
