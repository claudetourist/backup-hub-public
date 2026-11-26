/**
 * People (the table is called profiles; the words on screen are "people"): the colours, the plain sentences about who owns what, and the
 * rules that keep a chip readable. Pure data and pure functions, shared by main, preload and the window.
 */

/** The colours a person can have, in the order they are handed out. The first is the seeded "You" colour; the last is the app's person pink. */
export const PERSON_PALETTE: readonly { name: string; color: string }[] = [
  { name: 'Teal', color: '#0b6b5c' },
  { name: 'Purple', color: '#7a4fb5' },
  { name: 'Orange', color: '#c2571a' },
  { name: 'Blue', color: '#2f6fbf' },
  { name: 'Berry', color: '#a63d6e' },
  { name: 'Olive', color: '#5b7a1f' },
  { name: 'Pink', color: '#e74796' },
];

export const PERSON_COLORS: readonly string[] = PERSON_PALETTE.map((c) => c.color);

/** A palette colour (ignoring case), as the palette writes it; null when the text is not one of them. */
export function paletteColor(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const lower = text.trim().toLowerCase();
  return PERSON_COLORS.find((c) => c === lower) ?? null;
}

/** What a drive shows where a person would be: drives and the laptop belong to everyone. */
export const SHARED_WORD = 'Shared';

/** The name shown for "no one in particular" in the switcher. */
export const EVERYONE_WORD = 'Everyone';

function channel(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** The relative luminance of a #rrggbb colour (WCAG), 0 for anything else. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  return 0.2126 * channel(parseInt(m[1]!, 16)) + 0.7152 * channel(parseInt(m[2]!, 16)) + 0.0722 * channel(parseInt(m[3]!, 16));
}

/** The WCAG contrast ratio of two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#ffffff';
/** Pure black, not near black: with near black a mid-tone colour (luminance about 0.19) falls under 4.5 to 1 against both. */
const NEAR_BLACK = '#000000';

/** The text colour for a chip filled with the person's colour: white or black, whichever reads better (always at least 4.5 to 1). */
export function textOn(background: string): string {
  return contrastRatio(background, WHITE) >= contrastRatio(background, NEAR_BLACK) ? WHITE : NEAR_BLACK;
}

/** What a person still owns, counted for the "can they be removed" rule. */
export interface OwnedCounts {
  backups: number;
  phones: number;
  accounts: number;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "1 backup and 1 phone", "2 backups, 1 phone and 3 Google accounts"; empty when nothing. */
export function ownedText(owned: OwnedCounts): string {
  const parts: string[] = [];
  if (owned.backups > 0) parts.push(plural(owned.backups, 'backup', 'backups'));
  if (owned.phones > 0) parts.push(plural(owned.phones, 'phone', 'phones'));
  if (owned.accounts > 0) parts.push(plural(owned.accounts, 'Google account', 'Google accounts'));
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Why a person cannot be removed, in plain words; null when they own nothing. */
export function removeBlockedMessage(name: string, owned: OwnedCounts): string | null {
  const total = owned.backups + owned.phones + owned.accounts;
  if (total === 0) return null;
  return `${name} still has ${ownedText(owned)}. Give ${total === 1 ? 'it' : 'them'} to someone else first.`;
}

/** The line under a person's name in Settings: "Owns 1 backup and 1 phone" or "Owns nothing yet". */
export function ownsLine(owned: OwnedCounts): string {
  const text = ownedText(owned);
  return text === '' ? 'Owns nothing yet' : `Owns ${text}`;
}

/** The toast after a change of owner. */
export const ownerChangedText = (what: string, person: string): string => `${what} now belongs to ${person}.`;

/** What main answers to a change of owner. Only the database changes; nothing on a drive is moved or renamed. */
export type OwnerResult = { ok: true; message: string } | { ok: false; message: string };

/** Who a new phone belongs to: a person that exists, or a new one made with the backup. */
export type NewPhoneOwner = { id: number } | { newName: string };
