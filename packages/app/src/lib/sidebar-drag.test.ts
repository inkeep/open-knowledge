import { DOCUMENT_OPEN_BYTE_LIMIT } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  navigationForSidebarDragPayload,
  OK_SIDEBAR_DRAG_MIME,
  parseSidebarDragPayload,
  type SidebarDragPayload,
  serializeSidebarDragPayload,
} from './sidebar-drag';

function dataTransfer(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
  };
}

describe('sidebar drag payload', () => {
  test('round-trips doc, folder, and asset payloads', () => {
    const payloads: SidebarDragPayload[] = [
      { v: 1, kind: 'doc', docName: 'notes/Intro', size: null },
      { v: 1, kind: 'folder', folderPath: 'notes' },
      { v: 1, kind: 'asset', assetPath: 'media/cat.png', mediaKind: 'image' },
    ];

    for (const payload of payloads) {
      expect(
        parseSidebarDragPayload(
          dataTransfer({ [OK_SIDEBAR_DRAG_MIME]: serializeSidebarDragPayload(payload) }),
        ),
      ).toEqual(payload);
    }
  });

  test('ignores non-sidebar drops and malformed payloads', () => {
    expect(parseSidebarDragPayload(null)).toBeNull();
    expect(parseSidebarDragPayload(undefined)).toBeNull();
    expect(parseSidebarDragPayload(dataTransfer({ 'text/plain': 'notes/Intro.md' }))).toBeNull();
    expect(parseSidebarDragPayload(dataTransfer({ [OK_SIDEBAR_DRAG_MIME]: '{' }))).toBeNull();
    expect(
      parseSidebarDragPayload(
        dataTransfer({
          [OK_SIDEBAR_DRAG_MIME]: JSON.stringify({
            v: 1,
            kind: 'doc',
            docName: '',
            size: 100,
          }),
        }),
      ),
    ).toBeNull();
    expect(
      parseSidebarDragPayload(
        dataTransfer({
          [OK_SIDEBAR_DRAG_MIME]: JSON.stringify({
            v: 1,
            kind: 'unknown',
          }),
        }),
      ),
    ).toBeNull();
    expect(
      parseSidebarDragPayload(
        dataTransfer({
          [OK_SIDEBAR_DRAG_MIME]: JSON.stringify({
            v: 1,
            kind: 'asset',
            assetPath: 'media/cat.png',
            mediaKind: 'executable',
          }),
        }),
      ),
    ).toBeNull();
    expect(
      parseSidebarDragPayload(
        dataTransfer({
          [OK_SIDEBAR_DRAG_MIME]: JSON.stringify({
            v: 1,
            kind: 'asset',
            assetPath: 'media/cat.png',
            mediaKind: 'toString',
          }),
        }),
      ),
    ).toBeNull();
  });
});

describe('navigationForSidebarDragPayload', () => {
  test('doc payload opens a document target with document hash', () => {
    expect(
      navigationForSidebarDragPayload({ v: 1, kind: 'doc', docName: 'notes/Intro', size: 100 }),
    ).toEqual({
      target: { kind: 'doc', target: 'notes/Intro', docName: 'notes/Intro' },
      hash: '#/notes/Intro',
    });
  });

  test('large doc payload routes through the large-file target', () => {
    const result = navigationForSidebarDragPayload({
      v: 1,
      kind: 'doc',
      docName: 'huge',
      size: DOCUMENT_OPEN_BYTE_LIMIT + 1,
    });
    expect(result.hash).toBe('#/huge');
    expect(result.target.kind).toBe('large-file');
  });

  test('doc payload at the byte limit still opens a document tab', () => {
    const result = navigationForSidebarDragPayload({
      v: 1,
      kind: 'doc',
      docName: 'limit',
      size: DOCUMENT_OPEN_BYTE_LIMIT,
    });
    expect(result).toEqual({
      target: { kind: 'doc', target: 'limit', docName: 'limit' },
      hash: '#/limit',
    });
  });

  test('folder and asset payloads preserve their tab target kinds', () => {
    expect(navigationForSidebarDragPayload({ v: 1, kind: 'folder', folderPath: 'docs' })).toEqual({
      target: { kind: 'folder', target: 'docs', folderPath: 'docs' },
      hash: '#/docs/',
    });
    expect(
      navigationForSidebarDragPayload({
        v: 1,
        kind: 'asset',
        assetPath: 'images/cat.png',
        mediaKind: 'image',
      }),
    ).toEqual({
      target: {
        kind: 'asset',
        target: 'images/cat.png',
        assetPath: 'images/cat.png',
        mediaKind: 'image',
      },
      hash: '#/__asset__/images/cat.png',
    });
  });
});
