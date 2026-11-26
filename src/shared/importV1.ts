/** Types for the "bring in from Fleet Manager v1" import, shared by main, preload and renderer. */

export interface ImportV1Info {
  /** The archived copy the import reads (shown to the user). */
  sourceDir: string;
  /** Both archived files are present. */
  sourceFound: boolean;
}

export type ImportV1StartResult = { ok: true; jobId: number } | { ok: false; message: string };

/** Job kind of the import (the Settings screen finds its jobs by this). */
export const IMPORT_V1_JOB_KIND = 'import.fleetV1';
