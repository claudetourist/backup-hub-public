import fs from 'node:fs';
import { assertWritable, parseJsonLoose } from '../fsutil';
import { ownCreateNew, ownRemove } from '../danger/ownFiles';
import { cardFile, cardFolder, legacyCardFile } from './appFolders';

/**
 * The drive's ID card (`drive.json`): the drive's identity travels with the drive, not with a letter. It lives in the app's own files
 * on the drive (see `appFolders.ts`). A drive that has not been moved yet has it at the old place (the drive root): that card is READ
 * so the drive is still recognised, but nothing is ever written there.
 */
export { CARD_FILE } from '../../shared/appFolders';
const MAX_CARD_BYTES = 16 * 1024;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DriveCard {
  id: string;
  name: string;
  /** ISO 8601 */
  createdAt: string;
  appVersion: string;
}

export type CardRead =
  | { status: 'none' }
  /** `legacy` is set when the card was found only at the old place (an old-layout drive). */
  | { status: 'ok'; card: DriveCard; legacy?: true }
  /** Cards at BOTH places that name different drives: the drive needs the person's decision and nothing is written to it. `card` is the new place's, `oldCard` the old place's. */
  | { status: 'conflict'; card: DriveCard; oldCard: DriveCard }
  | { status: 'invalid'; reason: string }
  /** The drive itself could not be read (an error, or no answer in time): not the same as "no card" and not the same as a damaged card. */
  | { status: 'unreadable'; reason: string };

/** The card's place in the new layout (the only place a card is written). */
export function cardPath(root: string): string {
  return cardFile(root);
}

/** The old place of the card (read only). */
export function legacyCardPath(root: string): string {
  return legacyCardFile(root);
}

/** Check a parsed card; returns it normalised, or the reason it is unusable. */
export function validateCard(value: unknown): { ok: true; card: DriveCard } | { ok: false; reason: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not a JSON object' };
  const o = value as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || !UUID_PATTERN.test(o['id'])) return { ok: false, reason: 'missing or malformed id' };
  if (typeof o['name'] !== 'string' || o['name'].trim() === '' || o['name'].length > 200) {
    return { ok: false, reason: 'missing or malformed name' };
  }
  return {
    ok: true,
    card: {
      id: o['id'].toLowerCase(),
      name: o['name'].trim(),
      createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'] : '',
      appVersion: typeof o['appVersion'] === 'string' ? o['appVersion'] : '',
    },
  };
}

/** Parse the text of a card file. */
export function parseCard(text: string): CardRead {
  if (text.length > MAX_CARD_BYTES) return { status: 'invalid', reason: 'file is too large to be a card' };
  let parsed: unknown;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    return { status: 'invalid', reason: 'not valid JSON' };
  }
  const checked = validateCard(parsed);
  return checked.ok ? { status: 'ok', card: checked.card } : { status: 'invalid', reason: checked.reason };
}

async function readCardFile(file: string): Promise<CardRead> {
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    return parseCard(text);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'none' };
    return { status: 'unreadable', reason: `could not be read (${code ?? (err as Error).message})` };
  }
}

/**
 * Puts the two places together: the new place first, the old place only when the new one has no card. A card at both places that
 * names two different drives is a `conflict`; an old card that cannot be read next to a good new one is ignored (the new one decides).
 */
export function combineCardReads(fresh: CardRead, old: CardRead): CardRead {
  if (fresh.status === 'invalid' || fresh.status === 'unreadable') return fresh;
  if (fresh.status === 'ok') {
    if (old.status === 'ok' && old.card.id !== fresh.card.id) return { status: 'conflict', card: fresh.card, oldCard: old.card };
    return fresh;
  }
  if (old.status === 'ok') return { status: 'ok', card: old.card, legacy: true };
  if (old.status === 'invalid' || old.status === 'unreadable') return { status: old.status, reason: `the old card ${old.reason}` };
  return { status: 'none' };
}

/**
 * Read the card on a drive root. READ ONLY. The new place is read first, then the old place (see `combineCardReads`). A missing card
 * (or a missing folder) is `none`; an unreadable or malformed one is `invalid` so nothing ever overwrites it by accident.
 * Gives up after `timeoutMs` (a sleeping or failing drive can stall a read).
 */
export async function readDriveCard(root: string, timeoutMs = 4000): Promise<CardRead> {
  const read = (async (): Promise<CardRead> => {
    const [fresh, old] = await Promise.all([readCardFile(cardPath(root)), readCardFile(legacyCardPath(root))]);
    return combineCardReads(fresh, old);
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CardRead>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unreadable', reason: 'the drive did not answer in time' }), timeoutMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class CardExistsError extends Error {
  constructor() {
    super('This drive already has an ID card');
    this.name = 'CardExistsError';
  }
}

/**
 * Write the card in the new place (`cardPath`). Callers must have the user's explicit click. Never overwrites an existing card
 * (throws CardExistsError), and a drive that already has a card at the old place counts as having one: nothing is written next to it.
 * Writes a temporary file first, then links it into place.
 */
export function writeDriveCard(root: string, card: DriveCard): void {
  const file = cardPath(root);
  assertWritable(file); // T7 write ban: never write a card to a protected drive
  const dir = cardFolder(root);
  if (fs.existsSync(file) || fs.existsSync(legacyCardPath(root))) throw new CardExistsError();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(card, null, 2)}\n`, { flag: 'wx' });
    ownCreateNew(tmp, file); // never replaces a card: EEXIST when one appeared meanwhile
  } catch (err) {
    ownRemove(tmp);
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new CardExistsError();
    throw err;
  }
}
