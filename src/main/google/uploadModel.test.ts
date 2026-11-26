import { describe, expect, it } from 'vitest';
import { CHUNK_UNIT, chunkRange, confirmedBytes, isValidChunkSize, nextChunkLength, quoteDriveString, validateSessionUri } from './uploadModel';

const MIB = 1024 * 1024;

describe('uploadModel pure rules', () => {
  it('chunk sizes are multiples of 256 KiB and the last chunk is what is left', () => {
    expect(isValidChunkSize(16 * MIB)).toBe(true);
    expect(isValidChunkSize(CHUNK_UNIT + 1)).toBe(false);
    expect(isValidChunkSize(0)).toBe(false);
    expect(nextChunkLength(40 * MIB, 0, 16 * MIB)).toBe(16 * MIB);
    expect(nextChunkLength(40 * MIB, 32 * MIB, 16 * MIB)).toBe(8 * MIB);
    expect(nextChunkLength(40 * MIB, 40 * MIB, 16 * MIB)).toBe(0);
    expect(() => nextChunkLength(10, 0, 1000)).toThrow();
    expect(chunkRange(0, CHUNK_UNIT, 1000000)).toBe('bytes 0-262143/1000000');
  });

  it('reads the Range header of a 308', () => {
    expect(confirmedBytes(null)).toBe(0);
    expect(confirmedBytes('bytes=0-262143')).toBe(262144);
    expect(confirmedBytes('bytes=5-9')).toBeNull();
    expect(confirmedBytes('nonsense')).toBeNull();
  });

  it('only the exact session address is accepted', () => {
    expect(validateSessionUri('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc')).not.toBeNull();
    for (const bad of ['https://evil.example/upload/drive/v3/files?upload_id=abc', 'https://www.googleapis.com:8443/upload/drive/v3/files?upload_id=abc', 'https://u:p@www.googleapis.com/upload/drive/v3/files?upload_id=abc', 'http://www.googleapis.com/upload/drive/v3/files?upload_id=abc', 'https://www.googleapis.com/upload/drive/v3/files', null]) {
      expect(validateSessionUri(bad)).toBeNull();
    }
  });

  it('quotes names for a Drive query', () => {
    expect(quoteDriveString("it's a \\ test")).toBe("'it\\'s a \\\\ test'");
  });
});
