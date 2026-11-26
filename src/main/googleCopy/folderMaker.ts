import type { DriveUploader } from '../google/driveUpload';

/**
 * Makes the folders "Backup Hub / <backup> / ..." in a Google account, ONE creation per folder path per account even when several uploads ask at the
 * same moment: the second asker waits for the first one's answer instead of looking again and making a second folder with the same name.
 */
export class FolderMaker {
  private readonly known = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    private readonly uploader: Pick<DriveUploader, 'findFolder' | 'createFolder'>,
    /** A turn for the event loop (and the pause / stop point of the job) before each question to Google. */
    private readonly turn: () => Promise<void>,
  ) {}

  /** The id of the folder at the end of the path below the account's root ('root' when the path is empty): found when it is there, made when it is not. */
  async ensure(placeId: string, segments: readonly string[], signal: AbortSignal): Promise<string> {
    let parent = 'root';
    let key = placeId;
    for (const segment of segments) {
      key += '/' + segment;
      parent = await this.one(key, placeId, segment, parent, signal);
    }
    return parent;
  }

  private one(key: string, placeId: string, name: string, parent: string, signal: AbortSignal): Promise<string> {
    const id = this.known.get(key);
    if (id !== undefined) return Promise.resolve(id);
    let ask = this.pending.get(key);
    if (ask === undefined) {
      ask = (async () => {
        try {
          await this.turn();
          const found = (await this.uploader.findFolder(placeId, name, parent, signal)) ?? (await this.uploader.createFolder(placeId, name, parent, signal));
          this.known.set(key, found);
          return found;
        } finally {
          this.pending.delete(key);
        }
      })();
      this.pending.set(key, ask);
    }
    return ask;
  }
}
