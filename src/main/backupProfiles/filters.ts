/**
 * The filters of one backup profile: the same six lists as PhoneBackup (shared_config.py `_DEFAULT_FILTERS` and `get_filters`).
 * Stored as JSON text in `backup_profiles.filters_json`.
 */
export const FILTER_KEYS = ['protected_paths', 'media_allowlist', 'data_allowlist', 'skip_fragments', 'skip_extensions', 'known_wa_dotdirs'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Record<FilterKey, string[]>;

export const DEFAULT_FILTERS: Readonly<Filters> = {
  protected_paths: [
    '/sdcard/DCIM/', '/sdcard/Pictures/', '/sdcard/Photos/',
    '/sdcard/Movies/', '/sdcard/Music/', '/sdcard/Audiobooks/',
    '/sdcard/Alarms/', '/sdcard/Ringtones/', '/sdcard/Notifications/',
    '/sdcard/Podcasts/', '/sdcard/Subtitles/',
    '/sdcard/Download/', '/sdcard/Downloads/', '/sdcard/Documents/',
    '/sdcard/Recordings/', '/sdcard/MIUI/sound_recorder/',
    '/sdcard/IMP/', '/sdcard/MIUI/backup/AllBackup/',
    '/sdcard/WhatsApp/', '/sdcard/Telegram/',
  ],
  media_allowlist: [
    'com.whatsapp', 'com.whatsapp.w4b',
    'org.telegram.messenger', 'com.telegram.messenger',
    'com.openai.chatgpt', 'org.thoughtcrime.securesms',
    'com.instagram.android', 'com.snapchat.android',
    'com.facebook.orca', 'com.viber.voip',
  ],
  data_allowlist: [
    'com.android.soundrecorder', 'com.miui.soundrecorder',
    'com.google.android.dialer', 'com.miui.notes',
  ],
  skip_fragments: [
    '/.thumbnails/', '/.cache/', '/cache/', '/.trash/',
    '/.Thumbs/', '/.StickerThumbs/', '/.Links/',
    '/.Wamo/', '/.wamocache/', '/.Shared/',
    '/WhatsApp Bug Report Attachments/', '/WhatsApp AI Editor Cache/',
    '/MIUI/BugReportCache/', '/MIUI/debug_log/',
  ],
  skip_extensions: ['.nomedia', '.bizprofile', '.thumb', '.tmp'],
  known_wa_dotdirs: ['.statuses'],
};

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Like `get_filters`: every key the profile has overrides the default as a whole (an empty list stays empty); a missing key takes
 * the default. A value that is not a list of text is ignored (the default is used), so a hand-edited file cannot break a backup.
 */
export function mergeFilters(given: unknown): Filters {
  const own = given !== null && typeof given === 'object' && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
  const out = {} as Filters;
  for (const key of FILTER_KEYS) {
    const value = own[key];
    out[key] = isStringList(value) ? [...value] : [...DEFAULT_FILTERS[key]];
  }
  return out;
}

/** Filters from the stored JSON text (bad or empty text gives the defaults). */
export function parseFilters(json: string | null | undefined): Filters {
  if (!json) return mergeFilters(null);
  try {
    return mergeFilters(JSON.parse(json));
  } catch {
    return mergeFilters(null);
  }
}

export function filtersJson(filters: Filters): string {
  return JSON.stringify(filters);
}
