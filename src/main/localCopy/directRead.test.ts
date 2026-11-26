import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIRECT_BLOCK, hashUnbuffered } from './directRead';

/** The cache-free read with reused buffers: right answers for empty, small and multi-block files, one after another and at the same time; every byte handed on once. */
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-direct-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const make = (name: string, size: number, seed: number): { file: string; sha: string } => {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) data[i] = (i * 31 + seed) & 255;
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return { file, sha: createHash('sha256').update(data).digest('hex') };
};

describe('hashUnbuffered', () => {
  it('gives the right checksum for empty, small, exact-block and multi-block files, again and again with the reused buffer', async () => {
    const files = [make('empty', 0, 1), make('small', 100, 2), make('exact', DIRECT_BLOCK, 3), make('multi', DIRECT_BLOCK * 2 + 777, 4), make('tiny', 1, 5)];
    for (let round = 0; round < 3; round += 1) {
      for (const f of files) {
        let seen = 0;
        const hash = await hashUnbuffered(f.file, { onBlock: (b) => void (seen += b.length) });
        expect(hash.sha256).toBe(f.sha);
        expect(seen).toBe(hash.bytes);
        expect(hash.bytes).toBe(fs.statSync(f.file).size);
      }
    }
  });

  it('several reads at the same time do not share a buffer', async () => {
    const files = Array.from({ length: 6 }, (_, i) => make('f' + i, DIRECT_BLOCK + 1000 * (i + 1), i + 10));
    const results = await Promise.all(files.map((f) => hashUnbuffered(f.file, { yieldNow: () => new Promise<void>((r) => setImmediate(r)) })));
    expect(results.map((r) => r.sha256)).toEqual(files.map((f) => f.sha));
  });
});
