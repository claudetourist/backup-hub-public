/** Google Drive "shared with me": read only, listed on their own, and never counted as a backup copy. */
export interface SharedItemView {
  placeId: string;
  accountLabel: string;
  fileId: string;
  name: string;
  mimeType: string | null;
  size: number | null;
  /** Epoch ms. */
  mtime: number | null;
  owner: string | null;
  webLink: string | null;
}

export interface SharedAccountView {
  placeId: string;
  label: string;
  count: number;
  bytes: number;
  /** Epoch ms of the last look, null = never looked. */
  lookedAt: number | null;
  /** True when the account has more items than were read (the look stops at a fixed number). */
  truncated: boolean;
}

export interface SharedWithMeOverview {
  accounts: SharedAccountView[];
  /** The newest items first, at most `SHARED_SHOWN` of them. */
  items: SharedItemView[];
  totalItems: number;
}

export type SharedLookResult = { ok: true; count: number; truncated: boolean; message: string } | { ok: false; message: string };

export const SHARED_SHOWN = 500;
/** Pages (of 1,000) read per account in one look. */
export const SHARED_MAX_PAGES = 10;

export const SHARED_NOT_A_BACKUP = 'These files belong to other people, who can remove them or stop sharing at any time. They are not counted as a backup of your files.';
