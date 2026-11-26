import { rawFs as fs } from '../rawFs';

/** Reads bytes [start, start + length) of a file (read only, as a stream). */
export function readRange(file: string, start: number, length: number): Promise<Buffer<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    const stream = fs.createReadStream(file, { flags: 'r', start, end: start + length - 1, highWaterMark: 1024 * 1024 });
    stream.on('data', (part) => parts.push(typeof part === 'string' ? Buffer.from(part) : part));
    stream.on('error', reject);
    stream.on('end', () => {
      const data = Buffer.concat(parts);
      if (data.length !== length) reject(new Error('The file got shorter while it was being read.'));
      else resolve(data);
    });
  });
}
