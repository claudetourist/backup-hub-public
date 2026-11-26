import { describe, expect, it } from 'vitest';
import { cleanSegment, FolderPaths, UNKNOWN_FOLDER, withIdSuffix, type TreeNode } from './paths';

const node = (id: string, name: string, parentId: string | null): TreeNode => ({ id, name, parentId });

describe('FolderPaths', () => {
  it('builds My Drive paths through nested folders', () => {
    const folders = [node('A', 'Photos', 'ROOT'), node('B', '2026', 'A'), node('C', 'Docs', 'ROOT')];
    const paths = new FolderPaths(folders, ['B', 'C', 'ROOT', 'ROOT']);
    expect(paths.pathOf('trip.jpg', 'B')).toBe('My Drive/Photos/2026/trip.jpg');
    expect(paths.pathOf('a.txt', 'C')).toBe('My Drive/Docs/a.txt');
    expect(paths.pathOf('loose.txt', 'ROOT')).toBe('My Drive/loose.txt');
    expect(paths.pathOf('nul.txt', null)).toBe('My Drive/nul.txt');
    expect(paths.orphans).toBe(0);
  });

  it('puts files whose folder is not in the list under (unknown folder), and counts them', () => {
    const folders = [node('A', 'Photos', 'ROOT')];
    const paths = new FolderPaths(folders, ['A', 'ROOT', 'ROOT', 'GONE']);
    expect(paths.pathOf('x.jpg', 'GONE')).toBe(`${UNKNOWN_FOLDER}/x.jpg`);
    expect(paths.pathOf('y.jpg', 'A')).toBe('My Drive/Photos/y.jpg');
    expect(paths.orphans).toBe(1);
  });

  it('keeps the chain of a folder whose own parent is unknown', () => {
    const folders = [node('A', 'Shared', 'OTHER'), node('B', 'Sub', 'A')];
    const paths = new FolderPaths(folders, ['B', 'ROOT', 'ROOT']);
    expect(paths.pathOf('f', 'B')).toBe(`${UNKNOWN_FOLDER}/Shared/Sub/f`);
  });

  it('survives a folder cycle without looping forever', () => {
    const folders = [node('A', 'One', 'B'), node('B', 'Two', 'A')];
    const paths = new FolderPaths(folders, ['A']);
    const result = paths.pathOf('f.txt', 'A');
    expect(result.startsWith(`${UNKNOWN_FOLDER}/`)).toBe(true);
    expect(result.endsWith('/f.txt')).toBe(true);
    expect(paths.cycles).toBeGreaterThan(0);
  });

  it('survives a folder that is its own parent and a very deep chain', () => {
    const self = new FolderPaths([node('A', 'Loop', 'A')], ['A']);
    expect(self.pathOf('f', 'A')).toBe(`${UNKNOWN_FOLDER}/Loop/f`);
    const deep: TreeNode[] = [];
    for (let i = 0; i < 300; i += 1) deep.push(node(`n${i}`, `d${i}`, i === 299 ? 'ROOT' : `n${i + 1}`));
    const paths = new FolderPaths(deep, ['n0', 'ROOT']);
    expect(paths.pathOf('f', 'n0').endsWith('/f')).toBe(true);
  });

  it('cleans names: slashes, control characters, empty', () => {
    expect(cleanSegment('a/b')).toBe('a_b');
    expect(cleanSegment('  \u0001 ')).toBe('(no name)');
    expect(cleanSegment('')).toBe('(no name)');
    const paths = new FolderPaths([node('A', 'Q1/Q2', 'ROOT')], ['A', 'ROOT']);
    expect(paths.pathOf('x/y.txt', 'A')).toBe('My Drive/Q1_Q2/x_y.txt');
  });
});

describe('withIdSuffix', () => {
  it('inserts the id before the extension, or at the end', () => {
    expect(withIdSuffix('My Drive/a/photo.jpg', 'abcdef123456')).toBe('My Drive/a/photo [abcdef12].jpg');
    expect(withIdSuffix('My Drive/a/Notes', 'abcdef123456')).toBe('My Drive/a/Notes [abcdef12]');
    expect(withIdSuffix('My Drive/.hidden', 'abcdef123456')).toBe('My Drive/.hidden [abcdef12]');
  });
});
