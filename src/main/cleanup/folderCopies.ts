/**
 * Finds a verified copy of a phone file in a laptop folder of the Phone backup (read only).
 *
 * The folder is not in the catalog, so a copy is proven the only way there is: a file of the same size whose SHA-256 (read now)
 * equals the phone's. The folder is walked once per plan (names and sizes only), and a file is hashed only when its size equals
 * the size looked for. Hashes are remembered for the session by path, size and modified time.
 */
import type { Dirent } from 'node:fs';
import { rawFs as fs } from '../rawFs';
import path from 'node:path';
import { sha256OfFile } from './hashLocal';

const MAX_FILES = 300_000;

interface Entry {
  abs: string;
  size: number;
  mtimeMs: number;
}

export class FolderCopies {
  private readonly index = new Map<string, Map<number, Entry[]>>();

  constructor(private readonly hashes: Map<string, string> = new Map()) {}

  private walk(folder: string): Map<number, Entry[]> {
    const found = this.index.get(folder);
    if (found) return found;
    const bySize = new Map<number, Entry[]>();
    const stack = [folder];
    let count = 0;
    while (stack.length > 0 && count < MAX_FILES) {
      const dir = stack.pop()!;
      let names: Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of names) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(abs);
        else if (e.isFile() && !e.name.endsWith('.bhpart')) {
          try {
            const st = fs.statSync(abs);
            const list = bySize.get(st.size) ?? [];
            list.push({ abs, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
            bySize.set(st.size, list);
            count += 1;
          } catch {
            // vanished: ignore
          }
        }
      }
    }
    this.index.set(folder, bySize);
    return bySize;
  }

  /** The absolute path of a file in `folder` with this size and SHA-256 (hashed now), or null. */
  async find(folder: string, sha256: string, size: number, turn: () => Promise<void> = () => Promise.resolve()): Promise<string | null> {
    for (const entry of this.walk(folder).get(size) ?? []) {
      const key = `${entry.abs}|${entry.size}|${entry.mtimeMs}`;
      let sha = this.hashes.get(key);
      if (sha === undefined) {
        try {
          sha = await sha256OfFile(entry.abs, turn);
        } catch {
          continue;
        }
        this.hashes.set(key, sha);
      }
      if (sha === sha256) return entry.abs;
    }
    return null;
  }
}

/** True when `file` lies inside `folder` (both absolute; case ignored as Windows does). */
export function isInsideFolder(folder: string, file: string): boolean {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
