/**
 * Choices carried over from the old tool name a file or folder by its full Windows path ("C:\\Users\\x\\OneDrive\\IMP\\a.zip"). A folder backup
 * matches paths of the form "/source/<path below the backed-up folder>" (folderBackup/folderPaths.ts `rulePathOf`), so such a choice
 * matched nothing. The stored rows are NOT rewritten: when the choices of a folder backup are read for matching, a legacy path under the
 * backup's source folder is translated to "/source/<path below>" (the folder is compared without regard to case, slashes either way); one
 * outside the source folder names nothing this backup copies and is left out of the matching. Pure.
 */
import { FOLDER_ROOT_FOLDER, type BackupRule } from '../../shared/rules';

/** A full Windows path ("C:\\..." or "C:/...", or a network path "\\\\server\\share"). */
export const isLegacyWindowsPath = (p: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p);

/** Backslashes to slashes, no doubled or trailing slashes, no "\\\\?\\" long-path prefix. */
const flat = (p: string): string => p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/(?!^)\/{2,}/g, '/').replace(/\/+$/, '');

/**
 * "C:\\Users\\x\\OneDrive\\IMP\\a.zip" under the source folder "C:\\Users\\x\\OneDrive" -> "/source/IMP/a.zip". Null when the path is not under
 * the source folder (or is the source folder itself: the whole folder cannot be a choice).
 */
export function legacyToSourcePath(pattern: string, sourceRoot: string): string | null {
  const path = flat(pattern);
  const root = flat(sourceRoot);
  if (root === '' || path.length <= root.length + 1 || path.slice(0, root.length + 1).toLowerCase() !== root.toLowerCase() + '/') return null;
  const rel = path.slice(root.length + 1);
  return rel.split('/').includes('..') ? null : `${FOLDER_ROOT_FOLDER}/${rel}`;
}

/**
 * The choices of a folder backup with their legacy Windows paths translated (see the header). `keepOutside`: a legacy path outside the
 * source folder stays as it is (the list on screen shows it, so it can be undone) instead of being left out (matching).
 */
export function translateLegacyRules(rules: readonly BackupRule[], sourceRoot: string, keepOutside: boolean): BackupRule[] {
  const out: BackupRule[] = [];
  for (const rule of rules) {
    if (rule.scope === 'pattern' || !isLegacyWindowsPath(rule.pattern)) {
      out.push(rule);
      continue;
    }
    const translated = legacyToSourcePath(rule.pattern, sourceRoot);
    if (translated !== null) out.push({ ...rule, pattern: translated });
    else if (keepOutside) out.push(rule);
  }
  return out;
}
