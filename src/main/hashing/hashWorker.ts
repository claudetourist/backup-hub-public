import { parentPort, workerData } from 'node:worker_threads';
import { hashFile, SharedThrottle, threadThrottle } from './hashCore';
import type { WorkerReply, WorkerRequest } from './hasher';

/**
 * The hashing worker thread: reads files off the main process, so the window stays
 * responsive. It talks to `WorkerHasher` in hasher.ts. It never writes anything.
 */
const port = parentPort;
if (port) {
  // Every hashing worker gets the same shared time line from the main process, so the cap holds across all of them.
  const shared = (workerData as { throttle?: SharedArrayBuffer } | null)?.throttle;
  const throttle = shared ? new SharedThrottle(Date.now, shared) : threadThrottle;
  const cancelled = new Set<number>();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const send = (reply: WorkerReply): void => port.postMessage(reply);
  port.on('message', (request: WorkerRequest) => {
    if (request.type === 'cancel') {
      cancelled.add(request.id);
      return;
    }
    const { id } = request;
    let pending = 0;
    let lastSent = 0;
    void hashFile(request.path, {
      capBytesPerSec: request.capBytesPerSec,
      throttle,
      ...(request.size !== undefined ? { sizeHint: request.size } : {}),
      isCancelled: () => cancelled.has(id),
      onBytes: (n) => {
        pending += n;
        const now = Date.now();
        if (now - lastSent >= 200) {
          send({ type: 'bytes', id, bytes: pending });
          pending = 0;
          lastSent = now;
        }
      },
    }).then(
      (result) => {
        if (pending > 0) send({ type: 'bytes', id, bytes: pending });
        cancelled.delete(id);
        send({ type: 'done', id, result });
        return undefined;
      },
      () => undefined,
    );
  });
  send({ type: 'ready' });
}
