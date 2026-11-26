/** Pure words and rules of "Add a Google account", sign out, remove and the Google app key (no React), so they can be tested. */
import type { GoogleKeyInput } from '../../shared/googleCopy';

export const ADD_ACCOUNT_BUTTON = 'Add a Google account';
export const ADD_WAITING = 'Your web browser is open. Sign in there. On the permissions screen, tick "Select all" (the Google Drive box is not ticked by Google), then come back here.';
export const WHOSE_QUESTION = 'Whose account is this?';
export const KEY_TITLE = 'Google app key';
export const KEY_MISSING = 'The Google app key is not saved yet. Without it no account can be added or signed in. Paste the client ID and the client secret from Google below.';
export const KEY_SAVED = 'The Google app key is saved.';

/** The Google app key can be saved when both boxes hold something (the rest is checked in main). */
export function keyReady(input: GoogleKeyInput): boolean {
  return input.clientId.trim() !== '' && input.clientSecret.trim() !== '';
}

export const removeQuestion = (label: string): string => `Take ${label} off the list? Nothing in the Google account is deleted.`;
