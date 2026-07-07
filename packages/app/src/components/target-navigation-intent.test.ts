import { describe, expect, test } from 'bun:test';
import { resolveTargetNavigationIntent } from './target-navigation-intent';

describe('resolveTargetNavigationIntent', () => {
  test('routes canonical folder index targets through the folder hash', () => {
    expect(
      resolveTargetNavigationIntent('reports', {
        pages: new Set(['reports/index']),
        folderPaths: new Set(['reports']),
      }),
    ).toEqual({
      resolvedTarget: {
        kind: 'folder-index',
        target: 'reports',
        folderPath: 'reports',
        docName: 'reports/index',
        noteKind: 'canonical-index',
      },
      hashDocName: 'reports',
      hash: null,
      displayState: 'folder',
    });
  });

  test('keeps exact documents on their own hash target', () => {
    expect(
      resolveTargetNavigationIntent('reports/index', {
        pages: new Set(['reports/index']),
        folderPaths: new Set(['reports']),
      }),
    ).toEqual({
      resolvedTarget: {
        kind: 'doc',
        target: 'reports/index',
        docName: 'reports/index',
      },
      hashDocName: 'reports/index',
      hash: null,
      displayState: 'doc',
    });
  });

  test('treats legacy folder notes as folder navigation targets', () => {
    expect(
      resolveTargetNavigationIntent('reports', {
        pages: new Set(['reports/reports']),
      }),
    ).toEqual({
      resolvedTarget: {
        kind: 'folder-index',
        target: 'reports',
        folderPath: 'reports',
        docName: 'reports/reports',
        noteKind: 'legacy-folder-note',
      },
      hashDocName: 'reports',
      hash: null,
      displayState: 'folder',
    });
  });

  test('returns folder display state for folder-only targets', () => {
    expect(
      resolveTargetNavigationIntent('reports', {
        pages: new Set(),
        folderPaths: new Set(['reports']),
      }),
    ).toEqual({
      resolvedTarget: {
        kind: 'folder',
        target: 'reports',
        folderPath: 'reports',
      },
      hashDocName: 'reports',
      hash: null,
      displayState: 'folder',
    });
  });

  test('keeps missing targets on the existing missing-page hash path', () => {
    expect(
      resolveTargetNavigationIntent('reports', {
        pages: new Set(['docs/index']),
      }),
    ).toEqual({
      resolvedTarget: {
        kind: 'missing',
        target: 'reports',
      },
      hashDocName: 'reports',
      hash: null,
      displayState: 'missing',
    });
  });

  test('routes a bare-name target through the basename index when present (URL-hash parity with chip click)', () => {
    expect(
      resolveTargetNavigationIntent('analysis', {
        pages: new Set(['andrew-data/project-x/analysis']),
        pagesByBasename: new Map([['analysis', 'andrew-data/project-x/analysis']]),
      }),
    ).toEqual({
      resolvedTarget: {
        kind: 'doc',
        target: 'andrew-data/project-x/analysis',
        docName: 'andrew-data/project-x/analysis',
      },
      hashDocName: 'andrew-data/project-x/analysis',
      hash: null,
      displayState: 'doc',
    });
  });

  test('a GLOBAL skill bundle reference node carries the skill-file viewer hash', () => {
    // The graph click path uses `intent.hash` when present so the node routes to
    // the read-only skill-file viewer (`#/__skill-file__/…`) instead of wrapping
    // its synthetic docName as a `#/<doc>` hash (which would open a phantom tab).
    expect(
      resolveTargetNavigationIntent('__skill__/global/demo/references/notes', {
        pages: new Set(),
      }),
    ).toEqual({
      resolvedTarget: {
        kind: 'skill-file',
        target: 'global/demo/references/notes.md',
        scope: 'global',
        name: 'demo',
        path: 'references/notes.md',
      },
      hashDocName: 'global/demo/references/notes.md',
      hash: '#/__skill-file__/global/demo/references/notes.md',
      // Resolves to a real openable viewer, so it renders as a resolved node
      // (not the dashed-red "missing" treatment).
      displayState: 'doc',
    });
  });
});
