import type { ContextMenuItem, FileTreeDropTarget } from '@pierre/trees';
import { describe, expect, test } from 'vitest';
import { OK_SIDEBAR_DRAG_MIME } from '@/lib/sidebar-drag';
import {
  appendSidebarUploadFields,
  collectTreeFolderPathsFromDocuments,
  computeTreeAncestorPaths,
  computeTreeDropDestinationPath,
  createPagePathFromTreeDestination,
  createTreePlaceholder,
  docNameToTreePath,
  documentsToTreePaths,
  fileEntryFromUploadedPath,
  fileEntryToTreePath,
  filesFromExternalDrop,
  folderPathToTreeDirectoryPath,
  isExternalFileDrag,
  parentFolderPathForTreeItemDropTarget,
  relativePathForTreeItem,
  treeDirectoryPathToFolderPath,
  treeFilePathToDocName,
  treeFilePathToDocumentDocName,
  treeItemToTarget,
  treePathToAppPath,
  uploadedPathForSidebarDrop,
  uploadParentDocNameForFolderDrop,
} from './file-tree-adapter';
import { buildTrashAbsPath } from './file-tree-operations';
import type { DocEntry, FileEntry } from './file-tree-utils';

function doc(docName: string): DocEntry {
  return { kind: 'document', docName, size: 100, modified: '2026-01-01T00:00:00Z' };
}

function menuItem(path: string, kind: ContextMenuItem['kind']): ContextMenuItem {
  return {
    kind,
    name: path.split('/').filter(Boolean).at(-1) ?? path,
    path,
  };
}

function dropTarget(target: Partial<FileTreeDropTarget>): FileTreeDropTarget {
  return {
    directoryPath: null,
    flattenedSegmentPath: null,
    hoveredPath: null,
    kind: 'root',
    ...target,
  };
}

describe('file-tree-adapter', () => {
  test('converts document names into Trees file paths', () => {
    expect(docNameToTreePath('README')).toBe('README.md');
    expect(documentsToTreePaths([doc('README'), doc('docs/guide')])).toEqual([
      'README.md',
      'docs/guide.md',
    ]);
  });

  test('de-dupes entries that map to the same tree path', () => {
    const stale: FileEntry = {
      kind: 'document',
      docName: 'note',
      docExt: '.mdx',
      size: 0,
      modified: '2026-01-01T00:00:00Z',
    };
    const fresh: FileEntry = {
      kind: 'document',
      docName: 'note',
      docExt: '.mdx',
      size: 40,
      modified: '2026-01-01T00:00:01Z',
    };
    expect(documentsToTreePaths([stale, fresh])).toEqual(['note.mdx']);
  });

  test('a doubled markdown extension keeps its own row next to the base file', () => {
    const base: FileEntry = {
      kind: 'document',
      docName: 'name',
      docExt: '.md',
      size: 10,
      modified: '2026-01-01T00:00:00Z',
    };
    const doubled: FileEntry = {
      kind: 'document',
      docName: 'name.md',
      docExt: '.md',
      size: 20,
      modified: '2026-01-01T00:00:01Z',
    };
    expect(documentsToTreePaths([base, doubled])).toEqual(['name.md', 'name.md.md']);
    expect(documentsToTreePaths([doubled, base])).toEqual(['name.md.md', 'name.md']);
  });

  test('the relocated doubled-extension row still resolves to its real docName', () => {
    const base: FileEntry = {
      kind: 'document',
      docName: 'name',
      docExt: '.md',
      size: 10,
      modified: '2026-01-01T00:00:00Z',
    };
    const doubled: FileEntry = {
      kind: 'document',
      docName: 'name.md',
      docExt: '.md',
      size: 20,
      modified: '2026-01-01T00:00:01Z',
    };
    expect(treeFilePathToDocumentDocName('name.md.md', [base, doubled])).toBe('name.md');
    expect(treeFilePathToDocumentDocName('name.md', [base, doubled])).toBe('name');
    expect(treeFilePathToDocumentDocName('name.md.md', [doubled, base])).toBe('name.md');
    expect(treeFilePathToDocumentDocName('name.md', [doubled, base])).toBe('name');
  });

  test('server-qualified same-stem siblings keep their own paths and fabricate nothing', () => {
    const qualifiedMd: FileEntry = {
      kind: 'document',
      docName: 'note.md',
      docExt: '.md',
      size: 10,
      modified: '2026-01-01T00:00:00Z',
    };
    const qualifiedMdx: FileEntry = {
      kind: 'document',
      docName: 'note.mdx',
      docExt: '.mdx',
      size: 20,
      modified: '2026-01-01T00:00:00Z',
    };
    const unqualified: FileEntry = {
      kind: 'document',
      docName: 'note',
      docExt: '.mdx',
      size: 20,
      modified: '2026-01-01T00:00:00Z',
    };
    expect(documentsToTreePaths([qualifiedMd, qualifiedMdx, unqualified])).toEqual([
      'note.md',
      'note.mdx',
    ]);
  });

  test('server-qualified case-variant siblings keep their verbatim filenames', () => {
    const lower: FileEntry = {
      kind: 'document',
      docName: 'name.md',
      docExt: '.md',
      size: 1,
      modified: '',
    };
    const upper: FileEntry = {
      kind: 'document',
      docName: 'name.MD',
      docExt: '.MD',
      size: 2,
      modified: '',
    };
    expect(documentsToTreePaths([lower, upper])).toEqual(['name.md', 'name.MD']);
  });

  test('a lone doubled extension with no sibling still gets its real filename', () => {
    expect(
      documentsToTreePaths([
        { kind: 'document', docName: 'notes.md', docExt: '.md', size: 1, modified: '' },
      ]),
    ).toEqual(['notes.md.md']);
    expect(
      documentsToTreePaths([
        { kind: 'document', docName: 'docs/guide.md', docExt: '.md', size: 1, modified: '' },
      ]),
    ).toEqual(['docs/guide.md.md']);
  });

  test('every returned tree path is unique for adversarial collision input', () => {
    const entries: FileEntry[] = [
      { kind: 'document', docName: 'a', docExt: '.md', size: 1, modified: '' },
      { kind: 'document', docName: 'a.md', docExt: '.md', size: 1, modified: '' },
      { kind: 'document', docName: 'a.md.md', docExt: '.md', size: 1, modified: '' },
      { kind: 'document', docName: 'a.md', docExt: '.md', size: 2, modified: '' },
      { kind: 'document', docName: 'a', docExt: '.md', size: 3, modified: '' },
      { kind: 'document', docName: 'b.mdx', docExt: '.mdx', size: 1, modified: '' },
      { kind: 'document', docName: 'b', docExt: '.mdx', size: 1, modified: '' },
    ];
    const paths = documentsToTreePaths(entries);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(['a.md', 'a.md.md', 'a.md.md.md', 'b.mdx.mdx', 'b.mdx']);
  });

  test('a doubled extension sharing a stem with an .md/.mdx pair stays collapsed but never duplicates', () => {
    const entries: FileEntry[] = [
      { kind: 'document', docName: 'a.md', docExt: '.md', size: 1, modified: '' },
      { kind: 'document', docName: 'a.mdx', docExt: '.mdx', size: 2, modified: '' },
      { kind: 'document', docName: 'a.md', docExt: '.md', size: 3, modified: '' },
    ];
    const paths = documentsToTreePaths(entries);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(['a.md', 'a.mdx']);
  });

  test('converts Trees file and directory paths back to app paths', () => {
    expect(treeFilePathToDocName('docs/guide.md')).toBe('docs/guide');
    expect(treeFilePathToDocName('docs/guide')).toBe('docs/guide');
    expect(treeDirectoryPathToFolderPath('docs/')).toBe('docs');
    expect(folderPathToTreeDirectoryPath('docs')).toBe('docs/');
    expect(treePathToAppPath('docs/guide.md')).toBe('docs/guide');
    expect(treePathToAppPath('docs/')).toBe('docs');
  });

  test('collects canonical folder paths from flat documents', () => {
    expect(
      collectTreeFolderPathsFromDocuments([
        doc('docs/guide'),
        doc('docs/nested/page'),
        { kind: 'folder', path: 'empty/child', size: 0, modified: '2026-01-01T00:00:00Z' },
        doc('README'),
      ]),
    ).toEqual(['docs/', 'docs/nested/', 'empty/', 'empty/child/']);
  });

  test('excludes .ok/** from collected folder paths (skills are not tree folders)', () => {
    expect(
      collectTreeFolderPathsFromDocuments([
        doc('docs/guide'),
        doc('.ok/skills/my-skill/SKILL'),
        { kind: 'folder', path: '.ok/skills/my-skill', size: 0, modified: '' },
        doc('notes/.ok/templates/daily'),
      ]),
    ).toEqual(['docs/']);
  });

  test('includeOkFolders admits .ok folder paths for the revealed tree', () => {
    const entries = [
      doc('docs/guide'),
      doc('.ok/skills/my-skill/SKILL'),
      { kind: 'folder' as const, path: '.ok/skills/my-skill', size: 0, modified: '' },
      doc('notes/.ok/templates/daily'),
    ];
    expect(collectTreeFolderPathsFromDocuments(entries, { includeOkFolders: true })).toEqual([
      '.ok/',
      '.ok/skills/',
      '.ok/skills/my-skill/',
      'docs/',
      'notes/',
      'notes/.ok/',
      'notes/.ok/templates/',
    ]);
    expect(collectTreeFolderPathsFromDocuments(entries)).toEqual(['docs/']);
  });

  test('computes active ancestor paths using Trees directory slash convention', () => {
    expect(computeTreeAncestorPaths('README.md')).toEqual([]);
    expect(computeTreeAncestorPaths('docs/guide.md')).toEqual(['docs/']);
    expect(computeTreeAncestorPaths('docs/nested/')).toEqual(['docs/', 'docs/nested/']);
  });

  test('creates unique file and folder placeholders', () => {
    expect(createTreePlaceholder('file', 'docs', ['docs/Untitled.md'])).toEqual({
      addPath: 'docs/Untitled 2.md',
      renamePath: 'docs/Untitled 2.md',
    });
    expect(createTreePlaceholder('folder', '', ['New Folder/'])).toEqual({
      addPath: 'New Folder 2/',
      renamePath: 'New Folder 2/',
    });
  });

  test('converts create destinations to create-page paths', () => {
    expect(createPagePathFromTreeDestination('file', 'docs/new-note')).toBe('docs/new-note.md');
    expect(createPagePathFromTreeDestination('folder', 'docs/new-folder/')).toBe(
      'docs/new-folder/index.md',
    );
  });

  test('computes server move destinations from Trees drop targets', () => {
    expect(
      computeTreeDropDestinationPath(
        'docs/guide.md',
        dropTarget({ kind: 'root', directoryPath: null }),
      ),
    ).toBe('guide.md');
    expect(
      computeTreeDropDestinationPath(
        'docs/guide.md',
        dropTarget({ kind: 'directory', directoryPath: 'archive/', hoveredPath: 'archive/' }),
      ),
    ).toBe('archive/guide.md');
    expect(
      computeTreeDropDestinationPath(
        'docs/',
        dropTarget({ kind: 'directory', directoryPath: 'archive/', hoveredPath: 'archive/' }),
      ),
    ).toBe('archive/docs/');
  });

  test('promotes nested entries to root and treats already-root entries as no-ops', () => {
    const root = dropTarget({ kind: 'root', directoryPath: null });
    expect(computeTreeDropDestinationPath('docs/archive/', root)).toBe('archive/');
    expect(computeTreeDropDestinationPath('a/b/c/', root)).toBe('c/');
    expect(computeTreeDropDestinationPath('guide.md', root)).toBe('guide.md');
    expect(computeTreeDropDestinationPath('archive/', root)).toBe('archive/');
  });

  test('resolves external file drop targets to upload parent doc names', () => {
    expect(parentFolderPathForTreeItemDropTarget('docs/', true)).toBe('docs');
    expect(parentFolderPathForTreeItemDropTarget('docs/guide.md', false)).toBe('docs');
    expect(parentFolderPathForTreeItemDropTarget('assets/cat.png', false)).toBe('assets');
    expect(parentFolderPathForTreeItemDropTarget('README.md', false)).toBe('');

    expect(uploadParentDocNameForFolderDrop('docs', 'clip.pdf')).toBe('docs/clip.pdf');
    expect(uploadParentDocNameForFolderDrop('docs/', 'clip.pdf')).toBe('docs/clip.pdf');
    expect(uploadParentDocNameForFolderDrop('', 'clip.pdf')).toBe('clip.pdf');

    const formData = new FormData();
    appendSidebarUploadFields(formData, 'docs', 'clip.pdf');
    expect(formData.get('parentDocName')).toBe('docs/clip.pdf');
    expect(formData.get('placement')).toBe('parent-dir');

    expect(uploadedPathForSidebarDrop('docs', { src: 'clip.pdf' })).toBe('docs/clip.pdf');
    expect(
      uploadedPathForSidebarDrop('docs', { src: 'ignored.pdf', path: '/assets/clip.pdf' }),
    ).toBe('assets/clip.pdf');
    expect(uploadedPathForSidebarDrop('', { src: 'clip.pdf', deduped: true })).toBe('clip.pdf');
  });

  test('classifies uploaded sidebar files for optimistic entries', () => {
    const md = fileEntryFromUploadedPath('docs/notes.md', new File(['hello'], 'notes.md'));
    expect(md).toMatchObject({
      kind: 'document',
      docName: 'docs/notes',
      docExt: '.md',
      size: 5,
    });

    const mdx = fileEntryFromUploadedPath('docs/card.mdx', new File(['x'], 'card.mdx'));
    expect(mdx).toMatchObject({
      kind: 'document',
      docName: 'docs/card',
      docExt: '.mdx',
      size: 1,
    });

    const asset = fileEntryFromUploadedPath('img/photo.png', new File(['image'], 'photo.png'));
    expect(asset).toMatchObject({
      kind: 'asset',
      path: 'img/photo.png',
      assetExt: 'png',
      mediaKind: 'image',
      size: 5,
    });

    expect(fileEntryFromUploadedPath('Makefile', new File(['build'], 'Makefile'))).toBeNull();
  });

  test('detects external file drags without swallowing sidebar drags', () => {
    expect(isExternalFileDrag({ dataTransfer: { types: ['Files'] } })).toBe(true);
    expect(isExternalFileDrag({ dataTransfer: { types: ['Files', OK_SIDEBAR_DRAG_MIME] } })).toBe(
      false,
    );
    expect(isExternalFileDrag({ dataTransfer: { types: [OK_SIDEBAR_DRAG_MIME] } })).toBe(false);
    expect(isExternalFileDrag({ dataTransfer: null })).toBe(false);
  });

  test('filters ghost file entries from external drops', () => {
    const namedEmpty = new File([], 'empty.txt');
    const namelessContent = { name: '', size: 10 } as File;
    const ghost = { name: '', size: 0 } as File;

    expect(
      filesFromExternalDrop({ dataTransfer: { files: [ghost, namedEmpty, namelessContent] } }),
    ).toEqual([namedEmpty, namelessContent]);
  });

  test('converts context menu items to sidebar targets and relative paths', () => {
    const file = menuItem('docs/guide.md', 'file');
    const folder = menuItem('docs/', 'directory');

    expect(treeItemToTarget(file, [])).toEqual({
      kind: 'file',
      name: 'guide',
      path: 'docs/guide',
      treePath: 'docs/guide.md',
      docExt: '.md',
    });
    expect(treeItemToTarget(folder, [])).toEqual({
      kind: 'folder',
      name: 'docs',
      path: 'docs',
      treePath: 'docs/',
    });
    expect(relativePathForTreeItem(file)).toBe('docs/guide.md');
    expect(relativePathForTreeItem(folder)).toBe('docs');
  });

  test('treeItemToTarget detects .mdx and surfaces it via docExt', () => {
    const mdxFile = menuItem('docs/guide.mdx', 'file');
    expect(treeItemToTarget(mdxFile, [])).toEqual({
      kind: 'file',
      name: 'guide',
      path: 'docs/guide',
      treePath: 'docs/guide.mdx',
      docExt: '.mdx',
    });
  });

  test('docNameToTreePath honors a per-doc extension; defaults to .md', () => {
    expect(docNameToTreePath('README')).toBe('README.md');
    expect(docNameToTreePath('README', '.md')).toBe('README.md');
    expect(docNameToTreePath('docs/guide', '.mdx')).toBe('docs/guide.mdx');
    expect(docNameToTreePath('docs/guide.mdx', '.mdx')).toBe('docs/guide.mdx');
  });

  test('treeFilePathToDocName strips both .md and .mdx suffixes', () => {
    expect(treeFilePathToDocName('docs/guide.md')).toBe('docs/guide');
    expect(treeFilePathToDocName('docs/guide.mdx')).toBe('docs/guide');
  });

  test('treeFilePathToDocumentDocName preserves exact document identities', () => {
    const documents: FileEntry[] = [
      {
        kind: 'document',
        docName: 'docs/guide.mdx',
        docExt: '.mdx',
        size: 0,
        modified: '',
      },
    ];

    expect(treeFilePathToDocumentDocName('docs/guide.mdx', documents)).toBe('docs/guide.mdx');
    expect(treeFilePathToDocumentDocName('docs/missing.mdx', documents)).toBe('docs/missing');
  });

  test('treeFilePathToDocumentDocName preserves an extension row beside the opposite document extension', () => {
    const documents: FileEntry[] = [
      {
        kind: 'document',
        docName: 'docs/guide',
        docExt: '.mdx',
        size: 0,
        modified: '',
      },
      {
        kind: 'asset',
        path: 'docs/guide.md',
        assetExt: 'md',
        mediaKind: null,
        size: 0,
        modified: '',
      },
    ];

    expect(treeFilePathToDocumentDocName('docs/guide.md', documents)).toBe('docs/guide.md');
  });

  test('treeFilePathToDocumentDocName preserves extension rows when both variants are generic entries', () => {
    const documents: FileEntry[] = [
      {
        kind: 'asset',
        path: 'docs/guide.md',
        assetExt: 'md',
        mediaKind: null,
        size: 0,
        modified: '',
      },
      {
        kind: 'asset',
        path: 'docs/guide.mdx',
        assetExt: 'mdx',
        mediaKind: null,
        size: 0,
        modified: '',
      },
    ];

    expect(treeFilePathToDocumentDocName('docs/guide.md', documents)).toBe('docs/guide.md');
  });

  test('treeItemToTarget preserves exact document identities when present', () => {
    const mdxFile = menuItem('docs/guide.mdx', 'file');
    const documents: FileEntry[] = [
      {
        kind: 'document',
        docName: 'docs/guide.mdx',
        docExt: '.mdx',
        size: 0,
        modified: '',
      },
    ];

    expect(treeItemToTarget(mdxFile, documents)).toEqual({
      kind: 'file',
      name: 'guide',
      path: 'docs/guide.mdx',
      treePath: 'docs/guide.mdx',
      docExt: '.mdx',
    });
  });

  test('documentsToTreePaths uses each doc.docExt; absent docExt defaults to .md', () => {
    expect(
      documentsToTreePaths([
        { kind: 'document', docName: 'README', size: 0, modified: '' },
        { kind: 'document', docName: 'docs/guide', docExt: '.mdx', size: 0, modified: '' },
        { kind: 'document', docName: 'docs/legacy', docExt: '.md', size: 0, modified: '' },
        { kind: 'folder', path: 'empty', size: 0, modified: '' },
      ]),
    ).toEqual(['README.md', 'docs/guide.mdx', 'docs/legacy.md', 'empty/']);
  });

  test('fileEntryToTreePath preserves referenced asset paths', () => {
    expect(
      fileEntryToTreePath({
        kind: 'asset',
        path: 'docs/photo.png',
        assetExt: '.png',
        mediaKind: 'image',
        size: 0,
        modified: '',
      }),
    ).toBe('docs/photo.png');
  });

  test('treeItemToTarget(item, documents) returns the entry-authoritative docExt for an extensionless .md tree path', () => {
    const item: ContextMenuItem = {
      kind: 'file',
      name: 'Untitled',
      path: 'Untitled',
    };
    const documents: FileEntry[] = [
      { kind: 'document', docName: 'Untitled', docExt: '.md', size: 0, modified: '' },
    ];

    const target = treeItemToTarget(item, documents);

    expect(target.kind).toBe('file');
    expect(target.path).toBe('Untitled');
    expect(target.docExt).toBe('.md');
  });

  test('treeItemToTarget(item, documents) returns .mdx when the entry advertises it for an extensionless tree path', () => {
    const item: ContextMenuItem = {
      kind: 'file',
      name: 'Untitled',
      path: 'Untitled',
    };
    const documents: FileEntry[] = [
      { kind: 'document', docName: 'Untitled', docExt: '.mdx', size: 0, modified: '' },
    ];

    const target = treeItemToTarget(item, documents);

    expect(target.kind).toBe('file');
    expect(target.docExt).toBe('.mdx');
  });

  test('treeItemToTarget(item, documents) falls back to .md when DocumentEntry has undefined docExt', () => {
    const item: ContextMenuItem = { kind: 'file', name: 'Untitled', path: 'Untitled' };
    const documents: FileEntry[] = [
      { kind: 'document', docName: 'Untitled', docExt: undefined, size: 0, modified: '' },
    ];
    expect(treeItemToTarget(item, documents).docExt).toBe('.md');
  });
  test('treeItemToTarget(item, documents) falls back to .md when no entry exists for an extensionless tree path', () => {
    const item: ContextMenuItem = {
      kind: 'file',
      name: 'Untitled',
      path: 'Untitled',
    };
    const documents: FileEntry[] = [];

    expect(treeItemToTarget(item, documents).docExt).toBe('.md');
  });

  test('buildTrashAbsPath(treeItemToTarget(item, documents)) produces a workspace path with the on-disk extension', () => {
    const item: ContextMenuItem = {
      kind: 'file',
      name: 'Untitled',
      path: 'Untitled',
    };
    const documents: FileEntry[] = [
      { kind: 'document', docName: 'Untitled', docExt: '.md', size: 0, modified: '' },
    ];
    const target = treeItemToTarget(item, documents);

    const absPath = buildTrashAbsPath(target, {
      contentDir: '/workspace',
      pathSeparator: '/',
    });

    expect(absPath).toBe('/workspace/Untitled.md');
  });

  test('treeItemToTarget(item, documents) classifies asset-shaped paths explicitly', () => {
    const item: ContextMenuItem = {
      kind: 'file',
      name: 'photo.png',
      path: 'docs/photo.png',
    };
    const documents: FileEntry[] = [];

    const target = treeItemToTarget(item, documents);

    expect(target).toMatchObject({
      kind: 'asset',
      path: 'docs/photo.png',
      treePath: 'docs/photo.png',
    });
    expect(target.docExt).toBeUndefined();
  });

  test('treeItemToTarget(item, documents) restores an extensionless asset target from documents', () => {
    const item: ContextMenuItem = {
      kind: 'file',
      name: 'photo',
      path: 'docs/photo',
    };
    const documents: FileEntry[] = [
      {
        kind: 'asset',
        path: 'docs/photo.png',
        assetExt: '.png',
        mediaKind: 'image',
        size: 0,
        modified: '',
      },
    ];

    expect(treeItemToTarget(item, documents)).toEqual({
      kind: 'asset',
      name: 'photo.png',
      path: 'docs/photo.png',
      treePath: 'docs/photo.png',
    });
  });

  test('treeItemToTarget(item, documents) falls back to file when multiple assets share the extensionless stem', () => {
    const item: ContextMenuItem = { kind: 'file', name: 'photo', path: 'docs/photo' };
    const documents: FileEntry[] = [
      {
        kind: 'asset',
        path: 'docs/photo.png',
        assetExt: '.png',
        mediaKind: 'image',
        size: 0,
        modified: '',
      },
      {
        kind: 'asset',
        path: 'docs/photo.webp',
        assetExt: '.webp',
        mediaKind: 'image',
        size: 0,
        modified: '',
      },
    ];

    const target = treeItemToTarget(item, documents);

    expect(target.kind).toBe('file');
    expect(target.docExt).toBe('.md');
    expect(target.path).toBe('docs/photo');
  });
});

describe('docNameToTreePath — editable text docs', () => {
  test('maps a text docName to the tree path verbatim (no .md appended)', () => {
    expect(docNameToTreePath('src/util.ts')).toBe('src/util.ts');
    expect(docNameToTreePath('config.json')).toBe('config.json');
  });
});
