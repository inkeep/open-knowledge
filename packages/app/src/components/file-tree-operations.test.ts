import { describe, expect, test } from 'bun:test';
import {
  applyDeleteToDocuments,
  applyDuplicateToDocuments,
  applyRenameToDocuments,
  buildRenamedNodePath,
  buildTrashAbsPath,
  canonicalizeAssetTargetForDelete,
  type FileTreeTarget,
  isValidNodeName,
  normalizeRenameValue,
  planRenameCleanupCalls,
  remapActiveDocName,
} from './file-tree-operations';
import type { FileEntry } from './file-tree-utils';

const fileNode = {
  name: 'notes',
  path: 'docs/notes',
  kind: 'file',
} as const;

const folderNode = {
  name: 'docs',
  path: 'docs',
  kind: 'folder',
} as const;

const documents: FileEntry[] = [
  { kind: 'document', docName: 'docs/notes', size: 10, modified: '2026-04-13T00:00:00.000Z' },
  {
    kind: 'document',
    docName: 'docs/nested/page',
    size: 11,
    modified: '2026-04-13T00:00:00.000Z',
  },
  { kind: 'folder', path: 'docs/empty', size: 0, modified: '2026-04-13T00:00:00.000Z' },
  {
    kind: 'asset',
    path: 'docs/image.png',
    assetExt: '.png',
    mediaKind: 'image',
    size: 1,
    modified: '2026-04-13T00:00:00.000Z',
  },
  { kind: 'document', docName: 'README', size: 12, modified: '2026-04-13T00:00:00.000Z' },
];

describe('file-tree-operations', () => {
  test('normalizeRenameValue trims whitespace but preserves the raw name', () => {
    expect(normalizeRenameValue('file', '  renamed  ')).toBe('renamed');
    expect(normalizeRenameValue('folder', '  renamed  ')).toBe('renamed');
  });

  test('normalizeRenameValue preserves .md suffix as an explicit extension signal', () => {
    expect(normalizeRenameValue('file', 'renamed.md')).toBe('renamed.md');
    expect(normalizeRenameValue('folder', 'renamed.md')).toBe('renamed.md');
  });

  test('normalizeRenameValue preserves .mdx suffix as an explicit extension signal', () => {
    expect(normalizeRenameValue('file', 'renamed.mdx')).toBe('renamed.mdx');
    expect(normalizeRenameValue('folder', 'renamed.mdx')).toBe('renamed.mdx');
  });

  test('normalizeRenameValue leaves bare names unchanged (preserves backward-compat server re-derivation)', () => {
    expect(normalizeRenameValue('file', 'renamed')).toBe('renamed');
    expect(normalizeRenameValue('folder', 'renamed')).toBe('renamed');
  });

  test('isValidNodeName rejects path separators and dot segments', () => {
    expect(isValidNodeName('valid-name')).toBe(true);
    expect(isValidNodeName('nested/name')).toBe(false);
    expect(isValidNodeName('..')).toBe(false);
  });

  test('buildRenamedNodePath only replaces the last path segment', () => {
    expect(buildRenamedNodePath(fileNode, 'renamed')).toBe('docs/renamed');
    expect(buildRenamedNodePath(folderNode, 'guides')).toBe('guides');
  });

  test('applyRenameToDocuments remaps returned doc names', () => {
    expect(
      applyRenameToDocuments(documents, [
        { fromDocName: 'docs/notes', toDocName: 'docs/renamed' },
        { fromDocName: 'docs/nested/page', toDocName: 'guides/nested/page' },
      ]).map((entry) => (entry.kind === 'document' ? entry.docName : entry.path)),
    ).toEqual(['docs/renamed', 'guides/nested/page', 'docs/empty', 'docs/image.png', 'README']);
  });

  test('applyRenameToDocuments updates docExt for explicit extension-change rename', () => {
    const [renamed] = applyRenameToDocuments(
      [{ kind: 'document', docName: 'docs/notes', docExt: '.md', size: 10, modified: '' }],
      [{ fromDocName: 'docs/notes', toDocName: 'docs/notes' }],
      [],
      [],
      [{ toDocName: 'docs/notes', docExt: '.mdx' }],
    );

    expect(renamed).toMatchObject({
      kind: 'document',
      docName: 'docs/notes',
      docExt: '.mdx',
    });
  });

  test('applyRenameToDocuments remaps explicit folder and asset paths', () => {
    expect(
      applyRenameToDocuments(documents, [], [{ fromPath: 'docs', toPath: 'guides' }]).map(
        (entry) => (entry.kind === 'document' ? entry.docName : entry.path),
      ),
    ).toEqual(['docs/notes', 'docs/nested/page', 'guides/empty', 'guides/image.png', 'README']);
  });

  test('applyRenameToDocuments remaps explicit asset renames', () => {
    expect(
      applyRenameToDocuments(
        documents,
        [],
        [],
        [{ fromPath: 'docs/image.png', toPath: 'docs/hero.png' }],
      ).map((entry) => (entry.kind === 'document' ? entry.docName : entry.path)),
    ).toEqual(['docs/notes', 'docs/nested/page', 'docs/empty', 'docs/hero.png', 'README']);
  });

  test('applyRenameToDocuments converts a markdown document renamed to a non-document file', () => {
    const [renamed] = applyRenameToDocuments(
      [{ kind: 'document', docName: 'docs/notes', docExt: '.md', size: 10, modified: 'now' }],
      [],
      [],
      [{ fromPath: 'docs/notes.md', toPath: 'docs/notes.txt' }],
    );

    expect(renamed).toEqual({
      kind: 'asset',
      path: 'docs/notes.txt',
      assetExt: 'txt',
      mediaKind: null,
      size: 10,
      modified: 'now',
      referencedBy: [],
    });
  });

  test('applyRenameToDocuments converts a non-document file renamed to markdown', () => {
    const [renamed] = applyRenameToDocuments(
      [
        {
          kind: 'asset',
          path: 'docs/notes.txt',
          assetExt: 'txt',
          mediaKind: null,
          size: 10,
          modified: 'now',
        },
      ],
      [],
      [],
      [{ fromPath: 'docs/notes.txt', toPath: 'docs/notes.md' }],
    );

    expect(renamed).toEqual({
      kind: 'document',
      docName: 'docs/notes',
      docExt: '.md',
      size: 10,
      modified: 'now',
    });
  });

  test('applyDeleteToDocuments removes all deleted doc names', () => {
    expect(
      applyDeleteToDocuments(documents, ['docs/notes', 'docs/nested/page']).map((entry) =>
        entry.kind === 'document' ? entry.docName : entry.path,
      ),
    ).toEqual(['docs/empty', 'docs/image.png', 'README']);
  });

  test('applyDeleteToDocuments removes explicit deleted assets', () => {
    expect(
      applyDeleteToDocuments(documents, [], undefined, ['docs/image.png']).map((entry) =>
        entry.kind === 'document' ? entry.docName : entry.path,
      ),
    ).toEqual(['docs/notes', 'docs/nested/page', 'docs/empty', 'README']);
  });

  test('applyDeleteToDocuments removes explicit folder and asset descendants', () => {
    expect(
      applyDeleteToDocuments(documents, ['docs/notes', 'docs/nested/page'], 'docs').map((entry) =>
        entry.kind === 'document' ? entry.docName : entry.path,
      ),
    ).toEqual(['README']);
  });

  test('canonicalizeAssetTargetForDelete restores the asset extension from documents', () => {
    expect(
      canonicalizeAssetTargetForDelete(
        { kind: 'asset', path: 'docs/image', name: 'image' },
        documents,
      ),
    ).toEqual({ kind: 'asset', path: 'docs/image.png', name: 'image.png' });
  });

  test('canonicalizeAssetTargetForDelete leaves ambiguous extensionless assets unchanged', () => {
    expect(
      canonicalizeAssetTargetForDelete({ kind: 'asset', path: 'docs/image', name: 'image' }, [
        ...documents,
        {
          kind: 'asset',
          path: 'docs/image.jpg',
          assetExt: '.jpg',
          mediaKind: 'image',
          size: 1,
          modified: '2026-04-13T00:00:00.000Z',
        },
      ]),
    ).toEqual({ kind: 'asset', path: 'docs/image', name: 'image' });
  });

  test('canonicalizeAssetTargetForDelete only matches sibling assets', () => {
    expect(
      canonicalizeAssetTargetForDelete({ kind: 'asset', path: 'docs/image', name: 'image' }, [
        {
          kind: 'asset',
          path: 'docs/image.more/nested.png',
          assetExt: '.png',
          mediaKind: 'image',
          size: 1,
          modified: '2026-04-13T00:00:00.000Z',
        },
      ]),
    ).toEqual({ kind: 'asset', path: 'docs/image', name: 'image' });
  });

  test('applyDuplicateToDocuments adds a duplicated file with the source extension', () => {
    const next = applyDuplicateToDocuments(
      [
        {
          kind: 'document',
          docName: 'docs/source',
          docExt: '.mdx',
          size: 42,
          modified: '2026-04-13T00:00:00.000Z',
        },
      ],
      {
        kind: 'file',
        path: 'docs/source',
        name: 'source',
        docExt: '.mdx',
      },
      {
        kind: 'file',
        path: 'docs/source copy',
        duplicatedDocNames: ['docs/source copy'],
      },
      '2026-05-20T00:00:00.000Z',
    );

    expect(next).toEqual([
      {
        kind: 'document',
        docName: 'docs/source',
        docExt: '.mdx',
        size: 42,
        modified: '2026-04-13T00:00:00.000Z',
      },
      {
        kind: 'document',
        docName: 'docs/source copy',
        docExt: '.mdx',
        size: 42,
        modified: '2026-05-20T00:00:00.000Z',
      },
    ]);
  });

  test('applyDuplicateToDocuments adds a duplicated folder and visible copied docs', () => {
    const next = applyDuplicateToDocuments(
      documents,
      {
        kind: 'folder',
        path: 'docs',
        name: 'docs',
      },
      {
        kind: 'folder',
        path: 'docs copy',
        duplicatedDocNames: ['docs copy/notes', 'docs copy/nested/page'],
      },
      '2026-05-20T00:00:00.000Z',
    );

    expect(next.map((entry) => (entry.kind === 'document' ? entry.docName : entry.path))).toEqual([
      'docs/notes',
      'docs/nested/page',
      'docs/empty',
      'docs/image.png',
      'README',
      'docs copy',
      'docs copy/notes',
      'docs copy/nested/page',
      'docs copy/empty',
    ]);
  });

  test('remapActiveDocName returns renamed active path when present', () => {
    expect(
      remapActiveDocName('docs/notes', [{ fromDocName: 'docs/notes', toDocName: 'docs/renamed' }]),
    ).toBe('docs/renamed');
    expect(
      remapActiveDocName('README', [{ fromDocName: 'docs/notes', toDocName: 'docs/renamed' }]),
    ).toBe('README');
  });

  describe('planRenameCleanupCalls', () => {
    const poolHasAll = () => true;

    test('skips destination cleanup when redirect already reopened it', () => {
      expect(
        planRenameCleanupCalls(
          [{ fromDocName: 'docs/notes', toDocName: 'docs/renamed' }],
          'docs/renamed',
          poolHasAll,
        ),
      ).toEqual(['docs/notes']);
    });

    test('clears both ends when redirect has not run yet', () => {
      expect(
        planRenameCleanupCalls(
          [{ fromDocName: 'docs/notes', toDocName: 'docs/renamed' }],
          'docs/notes',
          poolHasAll,
        ),
      ).toEqual(['docs/notes', 'docs/renamed']);
    });

    test('clears both ends when the active doc is unrelated', () => {
      expect(
        planRenameCleanupCalls(
          [{ fromDocName: 'docs/notes', toDocName: 'docs/renamed' }],
          'README',
          poolHasAll,
        ),
      ).toEqual(['docs/notes', 'docs/renamed']);
    });

    test('clears both ends when active doc is unknown', () => {
      expect(
        planRenameCleanupCalls(
          [{ fromDocName: 'docs/notes', toDocName: 'docs/renamed' }],
          null,
          poolHasAll,
        ),
      ).toEqual(['docs/notes', 'docs/renamed']);
    });

    test('applies redirect guard per rename entry', () => {
      expect(
        planRenameCleanupCalls(
          [
            { fromDocName: 'docs/a', toDocName: 'archive/a' },
            { fromDocName: 'docs/b', toDocName: 'archive/b' },
            { fromDocName: 'docs/c', toDocName: 'archive/c' },
          ],
          'archive/a',
          poolHasAll,
        ),
      ).toEqual(['docs/a', 'docs/b', 'archive/b', 'docs/c', 'archive/c']);
    });

    test('empty rename batch — empty result', () => {
      expect(planRenameCleanupCalls([], null, poolHasAll)).toEqual([]);
      expect(planRenameCleanupCalls([], 'anything', poolHasAll)).toEqual([]);
    });

    test('skips destination cleanup when the pool never opened it', () => {
      expect(
        planRenameCleanupCalls(
          [{ fromDocName: 'Untitled', toDocName: 'dhx' }],
          'Untitled',
          () => false,
        ),
      ).toEqual(['Untitled']);
    });

    test('applies pool presence guard per rename entry', () => {
      const poolHas = (docName: string) => docName === 'archive/a' || docName === 'archive/c';
      expect(
        planRenameCleanupCalls(
          [
            { fromDocName: 'docs/a', toDocName: 'archive/a' },
            { fromDocName: 'docs/b', toDocName: 'archive/b' },
            { fromDocName: 'docs/c', toDocName: 'archive/c' },
          ],
          'README',
          poolHas,
        ),
      ).toEqual(['docs/a', 'archive/a', 'docs/b', 'docs/c', 'archive/c']);
    });
  });

  // `target.path` is extension-stripped for `.md` / `.mdx` files (see
  // `treeFilePathToDocName` in file-tree-adapter.ts), so the trash flow must
  // reconstruct the on-disk extension before handing the absolute path to
  // `bridge.shell.trashItem`. The peer call site at FileTree.tsx applyDelete
  // does the same via `docNameToTreePath(target.path, target.docExt)`. Folders
  // and assets pass through unchanged.
  describe('buildTrashAbsPath', () => {
    const posixWorkspace: { contentDir: string; pathSeparator: '/' | '\\' } = {
      contentDir: '/workspace',
      pathSeparator: '/',
    };

    test('.md file in a plain folder — restores the .md suffix on the absolute path', () => {
      const target: FileTreeTarget = {
        kind: 'file',
        path: 'notes/USER',
        name: 'USER',
        docExt: '.md',
      };
      expect(buildTrashAbsPath(target, posixWorkspace)).toBe('/workspace/notes/USER.md');
    });

    test('.mdx file in a plain folder — restores the .mdx suffix', () => {
      const target: FileTreeTarget = {
        kind: 'file',
        path: 'docs/guide',
        name: 'guide',
        docExt: '.mdx',
      };
      expect(buildTrashAbsPath(target, posixWorkspace)).toBe('/workspace/docs/guide.mdx');
    });

    test('.md file in a folder containing `+` — the user-reported case', () => {
      // `+` is incidental — the bug fires for any `.md` delete — but pinning
      // this literal input prevents a narrow "encode `+`" fix from looking
      // right while the real root cause (extension stripping) goes unaddressed.
      const target: FileTreeTarget = {
        kind: 'file',
        path: 'TLA+/USER',
        name: 'USER',
        docExt: '.md',
      };
      expect(buildTrashAbsPath(target, posixWorkspace)).toBe('/workspace/TLA+/USER.md');
    });

    test('folder target — path passes through unchanged (no extension to restore)', () => {
      const target: FileTreeTarget = {
        kind: 'folder',
        path: 'docs/archive',
        name: 'archive',
      };
      expect(buildTrashAbsPath(target, posixWorkspace)).toBe('/workspace/docs/archive');
    });

    test('asset (e.g. .png) path passes through unchanged', () => {
      // Assets carry their full content-relative path. The helper must not
      // append the default markdown extension.
      const target: FileTreeTarget = {
        kind: 'asset',
        path: 'docs/photo.png',
        name: 'photo.png',
      };
      expect(buildTrashAbsPath(target, posixWorkspace)).toBe('/workspace/docs/photo.png');
    });

    test('Windows-shaped workspace — relative POSIX path is converted to backslashes', () => {
      // joinWorkspacePath already rewrites `/` → `\` when sep is `\\`. The
      // helper must compose with that, not strip the extension first then
      // round-trip through a different normalizer.
      const target: FileTreeTarget = {
        kind: 'file',
        path: 'notes/USER',
        name: 'USER',
        docExt: '.md',
      };
      const winWorkspace: { contentDir: string; pathSeparator: '/' | '\\' } = {
        contentDir: 'C:\\Users\\me\\workspace',
        pathSeparator: '\\',
      };
      expect(buildTrashAbsPath(target, winWorkspace)).toBe(
        'C:\\Users\\me\\workspace\\notes\\USER.md',
      );
    });
  });
});
