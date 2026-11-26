import fs from 'node:fs';

/** Free bytes on the drive that holds `root`, or null when Windows will not say. Synchronous: only for code that cannot wait (startup, wiring that hands it over as a plain function). */
export function freeBytesOf(root: string): number | null {
  try {
    const s = fs.statfsSync(root);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** The same without holding the window's thread: the call goes to the drive on the thread pool. Used on every copy path. */
export async function freeBytesOfAsync(root: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(root);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
