import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetPhonesForTests, lastPhones, readPhones } from './phoneCache';

const answer = { adb: 'ready', phones: [], hint: null, newPhones: [], backupsWithoutPhone: [] } as const;

describe('the last answer to "which phone is plugged in"', () => {
  afterEach(() => {
    forgetPhonesForTests();
    vi.unstubAllGlobals();
  });

  it('is empty until a screen asks, then remembered; two screens asking at once share one question', async () => {
    const connected = vi.fn(() => Promise.resolve(answer));
    vi.stubGlobal('window', { backupHub: { phoneBackup: { connected } } });
    expect(lastPhones()).toBeNull();
    const [a, b] = await Promise.all([readPhones(), readPhones()]);
    expect(a).toBe(answer);
    expect(b).toBe(answer);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(lastPhones()).toBe(answer);
  });

  it('keeps the last good answer when asking again fails', async () => {
    let fail = false;
    vi.stubGlobal('window', { backupHub: { phoneBackup: { connected: () => (fail ? Promise.reject(new Error('x')) : Promise.resolve(answer)) } } });
    await readPhones();
    fail = true;
    await expect(readPhones()).rejects.toThrow();
    expect(lastPhones()).toBe(answer);
  });
});
