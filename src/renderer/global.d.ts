import type { BackupHubApi } from '../shared/ipc';

declare global {
  interface Window {
    /** Typed bridge exposed by the preload script. */
    backupHub: BackupHubApi;
  }
}
