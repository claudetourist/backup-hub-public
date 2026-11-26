/** The words and the request behind "Why?" on a file. Pure. */
import type { WhyLine, WhyRequest } from '../../shared/decisions';

export const WHY_LINK_TEXT = 'Why?';

/** The accessible name of a "Why?" link: it says which file. */
export const whyLinkLabel = (name: string): string => `Why? ${name}`;

export const whyTitle = (name: string): string => `Why: ${name}`;
export const WHY_SUBTITLE = 'Where it is, how it was checked, and what Backup Hub did with it. Nothing here changes anything.';
export const WHY_LOADING = 'Reading what Backup Hub knows about this file.';
export const WHY_FAILED = 'The explanation could not be read. Nothing was changed.';

/** A file of a phone backup, named by its phone path (the preview and the copy lists have paths, not ids). */
export const phoneFileRequest = (backupId: number, phonePath: string): WhyRequest => ({ backupId, phonePath });

/** The file the search found, named by the id of one of its copies. */
export const copyFileRequest = (fileId: number): WhyRequest => ({ fileId });

/** The colour class of a line (the words already say the same, the colour only helps the eye). */
export const toneClass = (tone: WhyLine['tone']): string => `tone-text tone-text--${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'bad' ? 'crit' : 'neutral'}`;

/** What the icon of a line says in words, for a screen reader (colour is never the only sign). */
export const toneWord = (tone: WhyLine['tone']): string | null => (tone === 'ok' ? 'Good: ' : tone === 'warn' ? 'Careful: ' : tone === 'bad' ? 'Problem: ' : null);
