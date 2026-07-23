import { describe, expect, test } from 'vitest';
import type { FileEntry } from '@/components/file-tree-utils';
import { sidebarDragPayloadForTreePath } from './sidebar-drag-payload';

const entries: FileEntry[] = [
  {
    kind: 'document',
    docName: 'notes/Intro',
    size: 123,
    modified: '2026-06-10T00:00:00.000Z',
  },
  {
    kind: 'asset',
    path: 'media/cat.png',
    assetExt: '.png',
    mediaKind: 'image',
    size: 456,
    modified: '2026-06-10T00:00:00.000Z',
  },
  {
    kind: 'folder',
    path: 'notes',
    size: 0,
    modified: '2026-06-10T00:00:00.000Z',
  },
];

describe('sidebarDragPayloadForTreePath', () => {
  test('builds document payloads with the entry size', () => {
    expect(sidebarDragPayloadForTreePath('notes/Intro.md', entries)).toEqual({
      v: 1,
      kind: 'doc',
      docName: 'notes/Intro',
      size: 123,
    });
  });

  test('falls back to page metadata when the document entry has no size', () => {
    const entriesWithMissingSize: FileEntry[] = [
      {
        kind: 'document',
        docName: 'notes/Intro',
        size: undefined as unknown as number,
        modified: '2026-06-10T00:00:00.000Z',
      },
    ];

    expect(
      sidebarDragPayloadForTreePath(
        'notes/Intro.md',
        entriesWithMissingSize,
        new Map([['notes/Intro', { size: 789 }]]),
      ),
    ).toEqual({
      v: 1,
      kind: 'doc',
      docName: 'notes/Intro',
      size: 789,
    });
  });

  test('builds folder and asset payloads from selection resolution', () => {
    expect(sidebarDragPayloadForTreePath('notes/', entries)).toEqual({
      v: 1,
      kind: 'folder',
      folderPath: 'notes',
    });
    expect(sidebarDragPayloadForTreePath('media/cat.png', entries)).toEqual({
      v: 1,
      kind: 'asset',
      assetPath: 'media/cat.png',
      mediaKind: 'image',
    });
  });

  test('returns null for transient or unknown tree paths', () => {
    expect(sidebarDragPayloadForTreePath('', entries)).toBeNull();
    expect(sidebarDragPayloadForTreePath('missing.md', entries)).toBeNull();
  });
});
