/** Rebuilding Drive folder paths from a v1 cache (pure). */

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const ROOT_NAME = 'My Drive';
export const UNKNOWN_FOLDER = '(unknown folder)';
const MAX_DEPTH = 100;

export interface TreeNode {
  id: string;
  name: string;
  parentId: string | null;
}

/** One path segment: no slashes, no control characters, never empty. */
export function cleanSegment(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f]/g, '').replace(/\//g, '_').trim();
  return cleaned === '' ? '(no name)' : cleaned;
}

/**
 * Resolves the folder segments above a file. A folder whose parent is not in the cache is either
 * the true My Drive root (Drive never lists it) or an orphan (shared, or removed). The root is the
 * missing parent id most items point at; every other missing parent is "(unknown folder)".
 */
export class FolderPaths {
  private readonly nodes = new Map<string, TreeNode>();
  private readonly memo = new Map<string, readonly string[]>();
  private rootId: string | null = null;
  /** Files whose folder chain ended somewhere unknown. */
  orphans = 0;
  /** Folder chains that looped back on themselves (or were absurdly deep). */
  cycles = 0;

  constructor(folders: Iterable<TreeNode>, fileParents: Iterable<string | null>) {
    for (const f of folders) this.nodes.set(f.id, f);
    const missing = new Map<string, number>();
    const note = (parentId: string | null) => {
      if (parentId && !this.nodes.has(parentId)) missing.set(parentId, (missing.get(parentId) ?? 0) + 1);
    };
    for (const parentId of fileParents) note(parentId);
    for (const f of this.nodes.values()) note(f.parentId);
    let best = 0;
    for (const [id, n] of missing) {
      if (n > best || (n === best && this.rootId !== null && id < this.rootId)) {
        best = n;
        this.rootId = id;
      }
    }
  }

  private base(parentId: string): readonly string[] {
    return parentId === this.rootId ? [ROOT_NAME] : [UNKNOWN_FOLDER];
  }

  /** Segments of the folder `folderId` (root first). `null` means directly in My Drive. */
  folderSegments(folderId: string | null): readonly string[] {
    if (folderId === null || folderId === '') return [ROOT_NAME];
    const known = this.memo.get(folderId);
    if (known) return known;
    const chain: TreeNode[] = [];
    const seen = new Set<string>();
    let base: readonly string[] | null = null;
    let current: string | null = folderId;
    while (base === null) {
      if (current === null || current === '') {
        base = [ROOT_NAME];
        break;
      }
      const memoised = this.memo.get(current);
      if (memoised) {
        base = memoised;
        break;
      }
      const node = this.nodes.get(current);
      if (!node) {
        base = this.base(current);
        break;
      }
      if (seen.has(current) || chain.length >= MAX_DEPTH) {
        this.cycles += 1;
        base = [UNKNOWN_FOLDER];
        break;
      }
      seen.add(current);
      chain.push(node);
      current = node.parentId;
    }
    const segments = [...base];
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const node = chain[i]!;
      segments.push(cleanSegment(node.name));
      this.memo.set(node.id, [...segments]);
    }
    return segments;
  }

  /** Full rel_path of a file. */
  pathOf(name: string, parentId: string | null): string {
    const segments = this.folderSegments(parentId);
    if (segments[0] === UNKNOWN_FOLDER) this.orphans += 1;
    return `${segments.join('/')}/${cleanSegment(name)}`;
  }
}

/** `relPath` with a short id inserted before the extension: "photo [ab12cd34].jpg". */
export function withIdSuffix(relPath: string, extId: string): string {
  const slash = relPath.lastIndexOf('/');
  const dir = relPath.slice(0, slash + 1);
  const name = relPath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const tag = ` [${extId.slice(0, 8)}]`;
  if (dot > 0 && name.length - dot <= 9) return `${dir}${name.slice(0, dot)}${tag}${name.slice(dot)}`;
  return `${dir}${name}${tag}`;
}
