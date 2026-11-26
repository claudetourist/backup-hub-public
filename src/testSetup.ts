/**
 * Runs before every test file. Tests build their data, drive and scratch folders under the system temp folder, so that folder counts as
 * an app-owned place for the narrow own-files entry, and verified copies keep their temp files in the drive temp folder (`appFolders.ts`) of a fake volume beside
 * the system temp folder (the real default is on the drive of the copy). The own-files tests set their own configuration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { configureOwnFiles } from './main/danger/ownFiles';
import { setCopyTmpResolverForTests } from './main/localCopy/verifiedCopy';
import { driveTmpFolder } from './main/places/appFolders';

const testVolume = path.join(os.tmpdir(), `bh-test-volume-${process.pid}`);
configureOwnFiles({ extraRoots: [os.tmpdir()] });
setCopyTmpResolverForTests(() => driveTmpFolder(testVolume));
afterAll(() => {
  fs.rmSync(testVolume, { recursive: true, force: true });
});
