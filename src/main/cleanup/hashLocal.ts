import { createHash } from 'node:crypto';
import { rawFs as fs } from '../rawFs';

const CHUNK = 4 * 1024 * 1024;

/** SHA-256 of a local file, read in chunks; `turn` gives the event loop a turn (and may throw when the job is cancelled). */
export async function sha256OfFile(file: string, turn: () => Promise<void> = () => Promise.resolve()): Promise<string> {
  const sha = createHash('sha256');
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      await turn();
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      sha.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return sha.digest('hex');
}
