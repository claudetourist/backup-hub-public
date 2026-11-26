/**
 * Lets the heavy counts (file stats, coverage, collection coverage) run ONE AT A TIME, whichever worker thread each
 * uses. On a machine with little free memory three full scans at once made each of them several times slower.
 * First come, first served; a failing task never blocks the ones behind it.
 */
export class ScanGate {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
