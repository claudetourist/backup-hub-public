import Database from 'better-sqlite3';
import { BUSY_TIMEOUT_MS } from '../db/connection';
import { runUpkeepProcess, type ParentPortLike } from './upkeepProcessCore';

/**
 * Entry of the upkeep process: an Electron utilityProcess started by the UpkeepScheduler (main side) only when the computer has been idle
 * for 3 minutes, on mains power, with no job and Pause everything off. It opens the database with its OWN connection (the journal mode
 * stays WAL from the file), does small chunks, and exits. Built as its own file next to main.js (forge.config.ts); loaded by that name.
 * Nothing here ever shows in Activity or on Home; a failure goes to the app log through the scheduler.
 */
const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (port) {
  void runUpkeepProcess(port, {
    open: (file) => {
      const db = new Database(file, { fileMustExist: true });
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.pragma('foreign_keys = ON'); // deleting an old job removes its log lines
      db.pragma('synchronous = NORMAL');
      return db;
    },
    now: Date.now,
    exit: (code) => process.exit(code),
  });
}
