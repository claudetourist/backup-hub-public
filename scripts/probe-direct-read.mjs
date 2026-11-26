// Probe: does a read through the "no Windows cache" flag (UV_FS_O_DIRECT, FILE_FLAG_NO_BUFFERING) really bypass the cache here?
//
//   node scripts/probe-direct-read.mjs <folder> [sizeMB] [--pull-test [seconds]]
//
// Writes ONE test file below <folder>\bh-probe-<pid>\ (default 256 MB), flushes it, then reads it back three ways and prints timings:
//   normal read (cache hot, right after the write), normal read again, and the unbuffered (direct) read. A direct read from a
//   real drive runs at the drive's speed; a cached read runs at memory speed. It also proves the flag is active: an unbuffered handle
//   refuses a read that is not sector aligned (EINVAL).
// --pull-test: after that, reads the first MB through BOTH handles every second for <seconds> (default 60). Unplug the drive during
//   it: the direct read must start failing at once, the normal read may keep answering from the cache.
// Removes only the folder it made. Never touches anything else. Do not point it at a backup root.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const pull = args.indexOf('--pull-test');
const pullSeconds = pull >= 0 && /^\d+$/.test(args[pull + 1] ?? '') ? Number(args[pull + 1]) : 60;
const positional = args.filter((a, i) => !a.startsWith('--') && !(pull >= 0 && i === pull + 1 && /^\d+$/.test(a)));
const folder = positional[0];
const sizeMb = Number(positional[1] ?? 256);
if (!folder || !Number.isFinite(sizeMb) || sizeMb < 1) {
  console.error('usage: node scripts/probe-direct-read.mjs <folder> [sizeMB] [--pull-test [seconds]]');
  process.exit(2);
}

const SECTOR = 4096;
const BLOCK = 1024 * 1024;
const named = fs.constants.UV_FS_O_DIRECT;
const FLAG = typeof named === 'number' && named !== 0 ? named : process.platform === 'win32' ? 0x02000000 : fs.constants.O_DIRECT;
console.log('node', process.version, process.platform);
console.log('fs.constants.UV_FS_O_DIRECT =', named, '(not exported on Windows: the libuv value 0x02000000 is used)');
console.log('flag used:', '0x' + (FLAG >>> 0).toString(16));
if (!FLAG) {
  console.error('FAIL: no unbuffered read flag on this system');
  process.exit(1);
}

const work = path.join(path.resolve(folder), 'bh-probe-' + process.pid);
const file = path.join(work, 'probe.bin');
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const rate = (bytes, t) => (bytes / 1e6 / (t / 1000)).toFixed(0) + ' MB/s';
let code = 0;

try {
  fs.mkdirSync(work, { recursive: true });
  const total = sizeMb * 1024 * 1024;
  const block = Buffer.alloc(BLOCK);
  const fd = fs.openSync(file, 'wx');
  let t0 = process.hrtime.bigint();
  for (let done = 0; done < total; done += BLOCK) {
    for (let i = 0; i < BLOCK; i += 8) block.writeUInt32LE((done + i) >>> 0, i);
    fs.writeSync(fd, block, 0, Math.min(BLOCK, total - done));
  }
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  console.log('wrote + flushed ' + sizeMb + ' MB in ' + ms(t0).toFixed(0) + ' ms');

  const normal = () => {
    const h = createHash('sha256');
    const f = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(BLOCK);
    for (;;) {
      const n = fs.readSync(f, buf, 0, BLOCK, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
    fs.closeSync(f);
    return h.digest('hex');
  };
  const openDirect = () => {
    const f = fs.openSync(file, fs.constants.O_RDONLY | FLAG);
    // Proof the flag is active: an unbuffered handle refuses a 1-byte read at an odd address.
    let refused = false;
    try {
      fs.readSync(f, Buffer.allocUnsafeSlow(SECTOR * 2), 1, 1, 0);
    } catch (e) {
      refused = e.code === 'EINVAL';
    }
    return { f, refused };
  };
  const big = Buffer.allocUnsafeSlow(BLOCK + SECTOR);
  let offset = -1;
  const direct = () => {
    const { f, refused } = openDirect();
    if (!refused) {
      fs.closeSync(f);
      throw new Error('the flag was NOT active: a 1-byte read was accepted');
    }
    const h = createHash('sha256');
    let pos = 0;
    for (;;) {
      let n = 0;
      if (offset < 0) {
        for (let at = 0; at < SECTOR; at += 16) {
          try {
            n = fs.readSync(f, big, at, BLOCK, 0);
            offset = at;
            break;
          } catch (e) {
            if (e.code !== 'EINVAL') throw e;
          }
        }
        if (offset < 0) throw new Error('no aligned place in the buffer');
      } else n = fs.readSync(f, big, offset, BLOCK, pos);
      if (n === 0) break;
      h.update(big.subarray(offset, offset + n));
      pos += n;
      if (n < BLOCK) break;
    }
    fs.closeSync(f);
    return h.digest('hex');
  };

  t0 = process.hrtime.bigint();
  const a = normal();
  const tHot = ms(t0);
  t0 = process.hrtime.bigint();
  const b = normal();
  const tHot2 = ms(t0);
  t0 = process.hrtime.bigint();
  const d = direct();
  const tDirect = ms(t0);
  console.log('normal read (hot, after write):', tHot.toFixed(0), 'ms', rate(total, tHot));
  console.log('normal read (hot again):       ', tHot2.toFixed(0), 'ms', rate(total, tHot2));
  console.log('direct read (no cache):        ', tDirect.toFixed(0), 'ms', rate(total, tDirect));
  console.log('same bytes:', a === b && b === d ? 'yes' : 'NO (' + a.slice(0, 8) + ' ' + b.slice(0, 8) + ' ' + d.slice(0, 8) + ')');
  console.log('flag proven active (1-byte read refused with EINVAL): yes');
  const ratio = tHot2 > 0 ? tDirect / tHot2 : Infinity;
  console.log('direct / normal time ratio:', ratio.toFixed(1) + 'x', ratio > 1.5 ? '=> consistent with the cache being bypassed' : '=> NOT clearly slower: the file may be too small or the drive as fast as memory; use a larger size, or the pull test');
  if (a !== d) code = 1;

  if (pull >= 0) {
    console.log('PULL TEST for ' + pullSeconds + ' s: unplug the drive now. Each line = direct read / normal read of the first MB.');
    const stop = Date.now() + pullSeconds * 1000;
    while (Date.now() < stop) {
      let dr = 'ok';
      let nr = 'ok';
      try {
        const { f } = openDirect();
        fs.readSync(f, big, offset, BLOCK, 0);
        fs.closeSync(f);
      } catch (e) {
        dr = 'FAILED ' + e.code;
      }
      try {
        const f = fs.openSync(file, 'r');
        fs.readSync(f, Buffer.allocUnsafe(BLOCK), 0, BLOCK, 0);
        fs.closeSync(f);
      } catch (e) {
        nr = 'FAILED ' + e.code;
      }
      console.log(new Date().toISOString().slice(11, 19), 'direct:', dr, ' normal:', nr);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
} catch (e) {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  code = 1;
} finally {
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    console.error('could not remove', work, '(remove that folder by hand)');
  }
}
process.exit(code);
