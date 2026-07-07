import { describe, expect, test } from 'bun:test';
import { resolveLinkTargetIntent } from './link-target-intent';

describe('resolveLinkTargetIntent', () => {
  test('navigates directly to an exact document target', () => {
    expect(resolveLinkTargetIntent('reports', { pages: new Set(['reports']) })).toEqual({
      kind: 'navigate',
      displayState: 'resolved',
      resolvedTarget: {
        kind: 'doc',
        target: 'reports',
        docName: 'reports',
      },
      hashDocName: 'reports',
      hash: null,
    });
  });

  test('keeps folder-like links navigable when a canonical index note exists', () => {
    expect(resolveLinkTargetIntent('reports', { pages: new Set(['reports/index']) })).toEqual({
      kind: 'navigate',
      displayState: 'resolved',
      resolvedTarget: {
        kind: 'folder-index',
        target: 'reports',
        folderPath: 'reports',
        docName: 'reports/index',
        noteKind: 'canonical-index',
      },
      hashDocName: 'reports',
      hash: null,
    });
  });

  test('keeps legacy folder notes navigable through the folder hash target', () => {
    expect(resolveLinkTargetIntent('reports', { pages: new Set(['reports/reports']) })).toEqual({
      kind: 'navigate',
      displayState: 'resolved',
      resolvedTarget: {
        kind: 'folder-index',
        target: 'reports',
        folderPath: 'reports',
        docName: 'reports/reports',
        noteKind: 'legacy-folder-note',
      },
      hashDocName: 'reports',
      hash: null,
    });
  });

  test('opens existing folders as folders instead of falling into create-page flow', () => {
    expect(
      resolveLinkTargetIntent('reports', {
        pages: new Set<string>(),
        folderPaths: new Set(['reports']),
      }),
    ).toEqual({
      kind: 'navigate',
      displayState: 'folder',
      resolvedTarget: {
        kind: 'folder',
        target: 'reports',
        folderPath: 'reports',
      },
      hashDocName: 'reports',
      hash: null,
    });
  });

  test('keeps true missing targets on the generic create-page path', () => {
    expect(resolveLinkTargetIntent('reports/new-note', { pages: new Set<string>() })).toEqual({
      kind: 'create',
      displayState: 'missing',
      resolvedTarget: {
        kind: 'missing',
        target: 'reports/new-note',
      },
      initialDir: 'reports',
      suggestedName: 'new-note.md',
    });
  });

  test('supports wiki-link slug fallback without misclassifying true missing targets', () => {
    expect(
      resolveLinkTargetIntent('My Notes', {
        pages: new Set(['my-notes']),
        fallbackTargets: ['my-notes'],
        createDialogSeed: {
          initialDir: '',
          suggestedName: 'My Notes.md',
        },
      }),
    ).toEqual({
      kind: 'navigate',
      displayState: 'resolved',
      resolvedTarget: {
        kind: 'doc',
        target: 'my-notes',
        docName: 'my-notes',
      },
      hashDocName: 'my-notes',
      hash: null,
    });
  });

  test('navigates a skill-bundle reference to the read-only viewer instead of create-page', () => {
    // A skill's `references/*` shows in Outgoing as a real, openable target — it
    // must NOT render as "Missing page — click to create" (which would create a
    // phantom page). It routes to the read-only skill-file viewer hash.
    expect(
      resolveLinkTargetIntent('__skill__/global/test/references/notes', {
        pages: new Set<string>(),
      }),
    ).toEqual({
      kind: 'navigate',
      displayState: 'resolved',
      resolvedTarget: {
        kind: 'skill-file',
        target: 'global/test/references/notes.md',
        scope: 'global',
        name: 'test',
        path: 'references/notes.md',
      },
      hashDocName: 'global/test/references/notes.md',
      hash: '#/__skill-file__/global/test/references/notes.md',
    });
  });
});
