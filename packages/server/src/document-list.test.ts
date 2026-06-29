import { describe, expect, test } from 'bun:test';
import { safeSubdir } from './api-extension.ts';
import type { FileIndexEntry } from './file-watcher.ts';


function listDocuments(
  index: ReadonlyMap<string, FileIndexEntry>,
  dir?: string,
): { docName: string; size: number; modified: string }[] {
  const documents: { docName: string; size: number; modified: string }[] = [];
  for (const [docName, entry] of index) {
    if (dir && !docName.startsWith(`${dir}/`) && docName !== dir) continue;
    documents.push({ docName, size: entry.size, modified: entry.modified });
  }
  return documents.sort((a, b) => a.docName.localeCompare(b.docName));
}

describe('document listing from file index', () => {
  const now = new Date().toISOString();
  const sampleIndex = new Map<string, FileIndexEntry>([
    [
      'README',
      { size: 50, modified: now, canonicalPath: '/test/README.md', inode: 0, aliases: [] },
    ],
    [
      'docs/guide',
      { size: 200, modified: now, canonicalPath: '/test/docs/guide.md', inode: 0, aliases: [] },
    ],
    [
      'docs/setup',
      { size: 150, modified: now, canonicalPath: '/test/docs/setup.md', inode: 0, aliases: [] },
    ],
    [
      'articles/intro',
      { size: 100, modified: now, canonicalPath: '/test/articles/intro.md', inode: 0, aliases: [] },
    ],
    [
      'articles/nested/deep',
      {
        size: 80,
        modified: now,
        canonicalPath: '/test/articles/nested/deep.md',
        inode: 0,
        aliases: [],
      },
    ],
  ]);

  test('lists all documents from index', () => {
    const docs = listDocuments(sampleIndex);
    expect(docs).toHaveLength(5);
    expect(docs.map((d) => d.docName)).toEqual([
      'articles/intro',
      'articles/nested/deep',
      'docs/guide',
      'docs/setup',
      'README',
    ]);
  });

  test('filters by dir prefix', () => {
    const docs = listDocuments(sampleIndex, 'docs');
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.docName)).toEqual(['docs/guide', 'docs/setup']);
  });

  test('filters nested dir prefix', () => {
    const docs = listDocuments(sampleIndex, 'articles');
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.docName)).toEqual(['articles/intro', 'articles/nested/deep']);
  });

  test('returns empty for non-existent dir prefix', () => {
    const docs = listDocuments(sampleIndex, 'nonexistent');
    expect(docs).toHaveLength(0);
  });

  test('returns empty for empty index', () => {
    const docs = listDocuments(new Map());
    expect(docs).toHaveLength(0);
  });

  test('preserves size and modified in response', () => {
    const docs = listDocuments(sampleIndex);
    const readme = docs.find((d) => d.docName === 'README');
    expect(readme).toBeTruthy();
    expect(readme?.size).toBe(50);
    expect(readme?.modified).toBe(now);
  });

  test('results are sorted alphabetically by docName', () => {
    const docs = listDocuments(sampleIndex);
    for (let i = 1; i < docs.length; i++) {
      expect(docs[i].docName.localeCompare(docs[i - 1].docName)).toBeGreaterThanOrEqual(0);
    }
  });
});


describe('safeSubdir', () => {
  test('resolves valid subdirectory', () => {
    const result = safeSubdir('/base/dir', 'sub');
    expect(result).toBe('/base/dir/sub');
  });

  test('rejects traversal attempt', () => {
    expect(() => safeSubdir('/base/dir', '../escape')).toThrow('Invalid directory');
  });

  test('allows identity (empty-ish path)', () => {
    const result = safeSubdir('/base/dir', '.');
    expect(result).toBe('/base/dir');
  });
});
