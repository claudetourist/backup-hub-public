import { createHash, type Hash } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import type { DigestReply, DigestRequest } from './blockDigest';

/**
 * The checksum worker thread: hashes the blocks the main process hands over (blockDigest.ts), so a copy's or a check's SHA-256 never
 * runs on the window's thread. It reads and writes nothing.
 */
const port = parentPort;
if (port) {
  const sessions = new Map<number, { sha: Hash; md5: Hash | null }>();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const send = (reply: DigestReply): void => port.postMessage(reply);
  port.on('message', (m: DigestRequest) => {
    try {
      switch (m.type) {
        case 'open':
          sessions.set(m.id, { sha: createHash('sha256'), md5: m.md5 ? createHash('md5') : null });
          return;
        case 'block': {
          const s = sessions.get(m.id);
          if (!s) return;
          const data = Buffer.from(m.data);
          s.sha.update(data);
          s.md5?.update(data);
          send({ type: 'ack', id: m.id });
          return;
        }
        case 'finish': {
          const s = sessions.get(m.id);
          sessions.delete(m.id);
          if (!s) {
            send({ type: 'fail', id: m.id, message: 'The checksum was not open.' });
            return;
          }
          send({ type: 'done', id: m.id, sha256: s.sha.digest('hex'), md5: s.md5 ? s.md5.digest('hex') : null });
          return;
        }
        case 'abort':
          sessions.delete(m.id);
          return;
      }
    } catch (err) {
      sessions.delete(m.id);
      send({ type: 'fail', id: m.id, message: err instanceof Error ? err.message : String(err) });
    }
  });
  send({ type: 'ready' });
}
