/**
 * Which of the person's choices applies to a phone path (PLAN.md section 3b). Pure: no database, no files.
 * Settled order: a choice of the person comes BEFORE the built-in filters; the most specific matching choice wins: a file, then the
 * deepest folder, then the shallowest folder, then a kind of file (an extension, any case). On a tie "include" wins (backing up more is the
 * safe side), and among equals the older choice (lower id) wins so the answer never depends on the order of the list.
 * Folder match is a path prefix with a "/" boundary and is case-sensitive (phone paths). A kind of file is "*.ext" only, no other globs.
 * Choices that name one destination (`destination` set) are not used yet and never match.
 * Precompiled per plan: three maps, so 60,000 paths against 200 choices cost one lookup per folder level, not 200 comparisons.
 */
import { cleanFolder, fileExtension, patternExtension, type BackupRule } from '../../shared/rules';

export interface CompiledRules {
  /** How many choices are in use. */
  readonly count: number;
  /** The choice that applies to this phone path, or null when none does. */
  match(path: string): BackupRule | null;
}

/** Of two choices for the same thing: include beats leave out; otherwise the older one stays. */
function stronger(current: BackupRule | undefined, next: BackupRule): BackupRule {
  if (current === undefined) return next;
  if (current.choice !== next.choice) return next.choice === 'include' ? next : current;
  return next.id < current.id ? next : current;
}

export function compileRules(rules: readonly BackupRule[]): CompiledRules {
  const files = new Map<string, BackupRule>();
  const folders = new Map<string, BackupRule>();
  const kinds = new Map<string, BackupRule>();
  let count = 0;
  for (const rule of rules) {
    if (rule.destination !== null) continue;
    if (rule.scope === 'file') files.set(rule.pattern, stronger(files.get(rule.pattern), rule));
    else if (rule.scope === 'folder') {
      const key = cleanFolder(rule.pattern);
      folders.set(key, stronger(folders.get(key), rule));
    } else {
      const ext = patternExtension(rule.pattern);
      if (ext === null) continue;
      kinds.set(ext, stronger(kinds.get(ext), rule));
    }
    count += 1;
  }
  const hasFiles = files.size > 0;
  const hasFolders = folders.size > 0;
  // Only a prefix whose length is the length of some folder choice can match: the others are not cut out of the path at all.
  let shortest = Infinity;
  let longest = 0;
  for (const key of folders.keys()) {
    shortest = Math.min(shortest, key.length);
    longest = Math.max(longest, key.length);
  }
  const hasKinds = kinds.size > 0;
  return {
    count,
    match(path: string): BackupRule | null {
      if (hasFiles) {
        const file = files.get(path);
        if (file !== undefined) return file;
      }
      if (hasFolders) {
        // Deepest folder first: "/sdcard/A/B/c.jpg" asks for "/sdcard/A/B", then "/sdcard/A", then "/sdcard".
        for (let i = path.lastIndexOf('/'); i >= shortest; i = path.lastIndexOf('/', i - 1)) {
          if (i > longest) continue;
          const folder = folders.get(path.slice(0, i));
          if (folder !== undefined) return folder;
        }
      }
      if (hasKinds) {
        const kind = kinds.get(fileExtension(path));
        if (kind !== undefined) return kind;
      }
      return null;
    },
  };
}

/** The one rule of "is it left out": a choice of the person decides when there is one, else the built-in filter. */
export function isLeftOut(rule: BackupRule | null, builtin: () => unknown): boolean {
  return rule !== null ? rule.choice === 'leave_out' : builtin() !== null;
}
