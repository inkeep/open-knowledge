import { describe, expect, test } from 'vitest';
import type { FileTreeTarget } from './file-tree-operations';
import {
  alternateMarkdownTreePath,
  buildRowDecorationIndex,
  deleteTargetCoversPendingCreate,
  hasSameStemMarkdownSiblingTreePath,
  isAgentTreePath,
  markdownTreeExtension,
  parseAlreadyExistsRenamePath,
  selectedTreePathsToDeleteTargets,
} from './file-tree-path-helpers';
import type { FileEntry } from './file-tree-utils';

const doc = (docName: string, docExt?: string): FileEntry => ({
  kind: 'document',
  docName,
  docExt,
  size: 1,
  modified: '2026-04-13T00:00:00.000Z',
});

const folder = (path: string): FileEntry => ({
  kind: 'folder',
  path,
  size: 0,
  modified: '2026-04-13T00:00:00.000Z',
});

const asset = (path: string): FileEntry => ({
  kind: 'asset',
  path,
  assetExt: '.png',
  mediaKind: 'image',
  size: 1,
  modified: '2026-04-13T00:00:00.000Z',
});

describe('file-tree-path-helpers', () => {
  test('parseAlreadyExistsRenamePath extracts the quoted path', () => {
    expect(parseAlreadyExistsRenamePath('"docs/notes.md" already exists.')).toBe('docs/notes.md');
    expect(parseAlreadyExistsRenamePath('some other error')).toBeNull();
  });

  test('markdownTreeExtension returns the matched extension or null', () => {
    expect(markdownTreeExtension('docs/notes.md')).toBe('.md');
    expect(markdownTreeExtension('docs/notes.MDX')).toBe('.MDX');
    expect(markdownTreeExtension('docs/image.png')).toBeNull();
  });

  test('isAgentTreePath flags agent/skill filenames case-insensitively', () => {
    expect(isAgentTreePath('AGENTS.md')).toBe(true);
    expect(isAgentTreePath('nested/claude.md')).toBe(true);
    expect(isAgentTreePath('skill')).toBe(true);
    expect(isAgentTreePath('docs/notes.md')).toBe(false);
  });

  test('alternateMarkdownTreePath swaps .md <-> .mdx and preserves the stem', () => {
    expect(alternateMarkdownTreePath('docs/notes.md')).toBe('docs/notes.mdx');
    expect(alternateMarkdownTreePath('docs/notes.mdx')).toBe('docs/notes.md');
    expect(alternateMarkdownTreePath('docs/image.png')).toBeNull();
  });

  test('hasSameStemMarkdownSiblingTreePath detects the alternate-extension sibling', () => {
    const paths = ['docs/notes.mdx', 'docs/other.md'];
    expect(hasSameStemMarkdownSiblingTreePath('docs/notes.md', paths)).toBe(true);
    expect(hasSameStemMarkdownSiblingTreePath('docs/other.md', paths)).toBe(false);
  });

  describe('selectedTreePathsToDeleteTargets', () => {
    const documents: FileEntry[] = [doc('docs/notes'), folder('docs'), doc('docs/nested/page')];

    test('deduplicates repeated selections', () => {
      const targets = selectedTreePathsToDeleteTargets(
        ['docs/notes.md', 'docs/notes.md'],
        documents,
      );
      expect(targets).toHaveLength(1);
      expect(targets[0].path).toBe('docs/notes');
    });

    test('excludes read-only .ok rows', () => {
      const targets = selectedTreePathsToDeleteTargets(
        ['docs/notes.md', 'docs/.ok/templates/trip.md'],
        documents,
      );
      expect(targets.map((t) => t.path)).toEqual(['docs/notes']);
    });

    test('drops paths already covered by a selected ancestor folder', () => {
      const targets = selectedTreePathsToDeleteTargets(['docs/', 'docs/notes.md'], documents);
      // The folder subsumes the file inside it — only the folder survives.
      expect(targets).toHaveLength(1);
      expect(targets[0].kind).toBe('folder');
      expect(targets[0].path).toBe('docs');
    });
  });

  describe('deleteTargetCoversPendingCreate', () => {
    const fileTarget = (path: string): FileTreeTarget => ({ kind: 'file', name: path, path });
    const folderTarget = (path: string): FileTreeTarget => ({ kind: 'folder', name: path, path });
    const assetTarget = (path: string): FileTreeTarget => ({ kind: 'asset', name: path, path });

    test('file target covers a pending file at the same path only', () => {
      expect(
        deleteTargetCoversPendingCreate(fileTarget('docs/new'), {
          kind: 'file',
          createdPath: 'docs/new',
        }),
      ).toBe(true);
      expect(
        deleteTargetCoversPendingCreate(fileTarget('docs/new'), {
          kind: 'file',
          createdPath: 'docs/other',
        }),
      ).toBe(false);
      // A file target never covers a pending folder.
      expect(
        deleteTargetCoversPendingCreate(fileTarget('docs/new'), {
          kind: 'folder',
          createdPath: 'docs/new',
        }),
      ).toBe(false);
    });

    test('asset target never covers a pending create', () => {
      expect(
        deleteTargetCoversPendingCreate(assetTarget('docs/img.png'), {
          kind: 'file',
          createdPath: 'docs/img.png',
        }),
      ).toBe(false);
    });

    test('folder target covers a pending create at or inside the folder', () => {
      expect(
        deleteTargetCoversPendingCreate(folderTarget('docs'), {
          kind: 'file',
          createdPath: 'docs/new',
        }),
      ).toBe(true);
      expect(
        deleteTargetCoversPendingCreate(folderTarget('docs'), {
          kind: 'folder',
          createdPath: 'docs',
        }),
      ).toBe(true);
      // A sibling folder that only shares a name prefix is not inside it.
      expect(
        deleteTargetCoversPendingCreate(folderTarget('docs'), {
          kind: 'folder',
          createdPath: 'docs-archive/new',
        }),
      ).toBe(false);
    });
  });

  describe('buildRowDecorationIndex', () => {
    test('keys documents by tree path and folders by directory path; skips assets', () => {
      const index = buildRowDecorationIndex([
        doc('docs/notes', '.md'),
        doc('README'),
        folder('docs/empty'),
        asset('docs/image.png'),
      ]);

      expect(index.docsByTreePath.get('docs/notes.md')?.kind).toBe('document');
      expect(index.docsByTreePath.get('README.md')?.kind).toBe('document');
      expect(index.foldersByTreeDirectoryPath.get('docs/empty/')?.kind).toBe('folder');
      // Assets are not indexed by either map.
      expect(index.docsByTreePath.has('docs/image.png')).toBe(false);
      expect(index.foldersByTreeDirectoryPath.has('docs/image.png')).toBe(false);
    });

    test('first entry wins on document key collision, matching Array.find', () => {
      const first = doc('dup', '.md');
      const second = doc('dup', '.md');
      const index = buildRowDecorationIndex([first, second]);
      expect(index.docsByTreePath.get('dup.md')).toBe(first);
    });

    test('first entry wins on folder key collision, matching Array.find', () => {
      const first = folder('dup');
      const second = folder('dup');
      const index = buildRowDecorationIndex([first, second]);
      expect(index.foldersByTreeDirectoryPath.get('dup/')).toBe(first);
    });
  });
});
