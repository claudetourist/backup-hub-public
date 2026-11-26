/**
 * The phone filters of PhoneBackup, ported exactly (source_adapters.py `ADBSource._passes_filter`, 45-84), with one change that the
 * plan demands (section 12): a file a filter drops is not forgotten; the filter that dropped it is named, so the preview can say
 * "left out: N files, X GB" per filter and folder and the person can include them.
 *
 * Order of the old code: skip extensions, skip fragments, WhatsApp hidden folders (all three are `_should_skip`); then everything under
 * /sdcard/Android is judged by the two allowlists only; then the protected paths pass; then a folder with a .nomedia file drops its
 * files; everything else passes. Pure: no phone, no files, no database.
 */
import type { Filters } from '../backupProfiles/filters';
import type { LeftOutFilter } from '../../shared/phoneBackup';

/** Python's `os.path.splitext(path)[1]`: leading dots of the name never start an extension, so ".nomedia" has none. */
export function pythonExt(p: string): string {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const stripped = name.replace(/^\.+/, '');
  const dot = stripped.lastIndexOf('.');
  return dot <= 0 ? '' : stripped.slice(dot);
}

/** The filter that drops this phone path, or null when it is wanted. `nomediaDirs` end with "/" (folders that hold a .nomedia file). */
export function leftOutBy(p: string, filters: Filters, nomediaDirs: readonly string[]): LeftOutFilter | null {
  if (filters.skip_extensions.includes(pythonExt(p).toLowerCase())) return 'temporary_file';
  if (filters.skip_fragments.some((frag) => p.includes(frag))) return 'cache_folder';
  if (p.includes('/WhatsApp/Media/.')) {
    const after = p.split('/WhatsApp/Media/.')[1];
    if (after !== undefined) {
      const dotdir = '.' + after.split('/')[0]!.toLowerCase();
      if (!filters.known_wa_dotdirs.includes(dotdir)) return 'whatsapp_hidden';
    }
  }
  if (p.includes('/sdcard/Android')) return androidAllowed(p, filters) ? null : 'android_data';
  if (filters.protected_paths.some((q) => p.startsWith(q))) return null;
  if (nomediaDirs.some((d) => p.startsWith(d))) return 'nomedia';
  return null;
}

function androidAllowed(p: string, filters: Filters): boolean {
  if (p.includes('/Android/media/')) return filters.media_allowlist.some((pkg) => p.includes(`/Android/media/${pkg}`));
  if (p.includes('/Android/data/')) return filters.data_allowlist.some((pkg) => p.includes(`/Android/data/${pkg}`));
  return false;
}

/** The folders that hold a .nomedia file, from the listing itself (every listed file is known, so no second phone command is needed). */
export function nomediaDirsOf(paths: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const p of paths) if (p.endsWith('/.nomedia')) out.add(p.slice(0, p.length - '.nomedia'.length));
  return [...out];
}

/** The folder a left-out file is counted under: the first three folders below /sdcard ("/sdcard/Android/data/com.x"). */
export function groupFolderOf(p: string): string {
  const parts = p.split('/'); // ['', 'sdcard', a, b, c, ...]
  const dirs = parts.slice(2, -1);
  return ['/sdcard', ...dirs.slice(0, 3)].join('/');
}
