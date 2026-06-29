import { describe, expect, test } from 'bun:test';
import type { ContextMenuItem, FileTreeDropTarget } from '@pierre/trees';
import { OK_SIDEBAR_DRAG_MIME } from '@/lib/sidebar-drag';
import {
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
  });

  test('treeFilePathToDocName strips both .md and .mdx suffixes', () => {
    expect(treeFilePathToDocName('docs/guide.md')).toBe('docs/guide');
    expect(treeFilePathToDocName('docs/guide.mdx')).toBe('docs/guide');
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
