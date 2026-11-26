import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { rawFs as fs } from '../rawFs';

/**
 * Reads bytes [offset, offset + length) of a file as ONE NEW stream, joined to a collecting writer with stream.pipeline (so a failure on either side
 * closes both and nothing is left open). A stream is used exactly once: every try of a chunk calls this again, a one-shot stream is never sent twice.
 */
export async function readChunk(file: string, offset: number, length: number, signal?: AbortSignal): Promise<Buffer<ArrayBuffer>> {
  const parts: Buffer[] = [];
  let got = 0;
  const sink = new Writable({
    write(part: Buffer, _encoding, done) {
      parts.push(part);
      got += part.length;
      done();
    },
  });
  const source = fs.createReadStream(file, { flags: 'r', start: offset, end: offset + length - 1, highWaterMark: 1024 * 1024 });
  await pipeline(source, sink, signal ? { signal } : {});
  if (got !== length) throw new Error('The file got shorter while it was being read.');
  return Buffer.concat(parts, got);
}
