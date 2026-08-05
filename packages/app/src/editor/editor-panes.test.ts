import { describe, expect, test } from 'vitest';
import {
  closeTabsInPane,
  createEmptyEditorPane,
  createEmptyEditorWorkspace,
  type EditorWorkspaceState,
  findPaneOwningTab,
  flattenWorkspacePinnedTabs,
  flattenWorkspaceTabs,
  focusEditorPane,
  hydrateEditorWorkspace,
  moveTabToPane,
  normalizeEditorWorkspace,
  parsePersistedEditorWorkspace,
  persistEditorWorkspace,
  projectVisibleEditorWorkspace,
  pruneEmptyEditorPanes,
  recordRecentlyClosedTab,
  remapWorkspaceTabs,
  reorderPaneTabs,
  splitTabToPane,
  tabBucketIndexForVisibleInsertion,
  transitionEditorWorkspace,
} from './editor-panes';

function docTarget(docName: string) {
  return { kind: 'doc' as const, target: docName, docName };
}

function pane(
  id: string,
  openTabs: string[],
  activeTabId: string | null = openTabs[0] ?? null,
  size = 100,
) {
  return {
    ...createEmptyEditorPane(id, size),
    openTabs,
    activeTabId,
    activeTarget: activeTabId ? docTarget(activeTabId) : null,
  };
}

describe('editor pane workspace', () => {
  test('rejects malformed workspaces and drops legacy occurrence ids', () => {
    const malformed = parsePersistedEditorWorkspace({ panes: [{ id: '', openTabs: ['a'] }] });
    const legacy = parsePersistedEditorWorkspace({
      panes: [
        {
          id: 'pane-a',
          openTabs: ['a', 'a\u0000doc-tab:1', 'b', 42],
          pinnedTabIds: ['a\u0000doc-tab:1', 'missing'],
          activeTabId: 'a\u0000doc-tab:1',
          size: 0,
        },
      ],
      focusedPaneId: 'missing-pane',
    });

    expect(malformed).toEqual({
      panes: [{ id: 'pane-main', openTabs: [], pinnedTabIds: [], activeTabId: null, size: 100 }],
      focusedPaneId: 'pane-main',
    });
    expect(legacy).toEqual({
      panes: [
        {
          id: 'pane-a',
          openTabs: ['a', 'b'],
          pinnedTabIds: [],
          activeTabId: 'a',
          size: 100,
        },
      ],
      focusedPaneId: 'pane-a',
    });
  });

  test('hydrates persisted panes with empty runtime-only state', () => {
    expect(
      hydrateEditorWorkspace({
        panes: [
          {
            id: 'pane-a',
            openTabs: ['a'],
            pinnedTabIds: ['a'],
            activeTabId: 'a',
            size: 100,
          },
        ],
        focusedPaneId: 'pane-a',
      }),
    ).toEqual({
      panes: [
        {
          id: 'pane-a',
          openTabs: ['a'],
          pinnedTabIds: ['a'],
          activeTabId: 'a',
          previewTabId: null,
          newTabIds: [],
          activeNewTabId: null,
          activeTarget: null,
          size: 100,
        },
      ],
      focusedPaneId: 'pane-a',
    });
  });

  test('normalizes current ids, target ownership, pins, focus, and size percentages', () => {
    const workspace = normalizeEditorWorkspace({
      panes: [
        {
          ...pane('pane-a', ['a', 'a\u0000doc-tab:1', 'b'], 'missing', 1),
          pinnedTabIds: ['a', 'missing'],
        },
        { ...pane('pane-a', ['c'], 'c', 1) },
        { ...pane('pane-b', ['b', 'c'], 'c', 3) },
      ],
      focusedPaneId: 'missing',
    });

    expect(workspace).toEqual({
      panes: [
        {
          ...pane('pane-a', ['a', 'b'], 'a', 25),
          pinnedTabIds: ['a'],
          activeTarget: null,
        },
        { ...pane('pane-b', ['c'], 'c', 75) },
      ],
      focusedPaneId: 'pane-a',
    });
    expect(flattenWorkspaceTabs(workspace)).toEqual(['a', 'b', 'c']);
    expect(flattenWorkspacePinnedTabs(workspace)).toEqual(['a']);
    expect(findPaneOwningTab(workspace, 'a')?.id).toBe('pane-a');
    expect(findPaneOwningTab(workspace, 'a\u0000doc-tab:7')).toBeNull();
  });

  test('falls back to the first tab when a persisted pane has no valid active tab', () => {
    const workspace = parsePersistedEditorWorkspace({
      panes: [
        {
          id: 'pane-a',
          openTabs: ['a', 'b'],
          pinnedTabIds: [],
          activeTabId: null,
          size: 50,
        },
        {
          id: 'pane-b',
          openTabs: ['c', 'd'],
          pinnedTabIds: [],
          activeTabId: 'missing',
          size: 50,
        },
      ],
      focusedPaneId: 'pane-b',
    });

    expect(workspace.panes.map(({ id, activeTabId }) => ({ id, activeTabId }))).toEqual([
      { id: 'pane-a', activeTabId: 'a' },
      { id: 'pane-b', activeTabId: 'c' },
    ]);
  });

  test('normalizes every non-empty runtime pane to exactly one active tab', () => {
    const workspace = normalizeEditorWorkspace({
      panes: [
        { ...pane('pane-a', ['a'], null, 50), activeTarget: docTarget('stale') },
        {
          ...pane('pane-b', [], null, 50),
          newTabIds: ['new-tab:1'],
          activeNewTabId: null,
        },
      ],
      focusedPaneId: 'pane-a',
    });

    expect(workspace.panes[0]).toMatchObject({
      activeTabId: 'a',
      activeNewTabId: null,
      activeTarget: null,
    });
    expect(workspace.panes[1]).toMatchObject({
      activeTabId: null,
      activeNewTabId: 'new-tab:1',
      activeTarget: null,
    });
  });

  test('lets the focused pane claim document tabs first, prunes empty panes, and normalizes sizes', () => {
    const workspace = parsePersistedEditorWorkspace({
      panes: [
        {
          id: 'pane-a',
          openTabs: ['a', 'b'],
          pinnedTabIds: ['a'],
          activeTabId: 'b',
          size: 25,
        },
        {
          id: 'pane-b',
          openTabs: ['a'],
          pinnedTabIds: ['a'],
          activeTabId: 'a',
          size: 50,
        },
        {
          id: 'pane-c',
          openTabs: ['a', 'c'],
          pinnedTabIds: [],
          activeTabId: 'c',
          size: 25,
        },
        {
          id: 'pane-d',
          openTabs: ['a'],
          pinnedTabIds: [],
          activeTabId: 'a',
          size: 100,
        },
      ],
      focusedPaneId: 'pane-b',
    });

    expect(workspace).toEqual({
      panes: [
        { id: 'pane-a', openTabs: ['b'], pinnedTabIds: [], activeTabId: 'b', size: 25 },
        { id: 'pane-b', openTabs: ['a'], pinnedTabIds: ['a'], activeTabId: 'a', size: 50 },
        { id: 'pane-c', openTabs: ['c'], pinnedTabIds: [], activeTabId: 'c', size: 25 },
      ],
      focusedPaneId: 'pane-b',
    });
    expect(parsePersistedEditorWorkspace(workspace)).toEqual(workspace);
  });

  test('splits a tab into a new side-by-side pane, clears the new selection target, and preserves the old selection', () => {
    const workspace: EditorWorkspaceState = {
      panes: [pane('pane-a', ['a', 'b'], 'a')],
      focusedPaneId: 'pane-a',
    };

    const split = splitTabToPane(workspace, 'b', 'pane-a', 'right', () => 'pane-b');

    expect(split.panes).toEqual([
      { ...pane('pane-a', ['a'], 'a', 50) },
      { ...pane('pane-b', ['b'], 'b', 50), activeTarget: null },
    ]);
    expect(split.focusedPaneId).toBe('pane-b');
    expect(splitTabToPane(split, 'b', 'pane-b', 'left', () => 'pane-c')).toEqual(split);
    expect(splitTabToPane(workspace, 'b', 'pane-a', 'right', () => 'pane-a')).toBe(workspace);
  });

  test('splits folder and blank tabs when they share a pane', () => {
    const folderTabId = '\u0000folder:New Folder 5';
    const newTabId = 'new-tab:1';
    const workspace: EditorWorkspaceState = {
      panes: [
        {
          ...pane('pane-a', [folderTabId], folderTabId),
          newTabIds: [newTabId],
        },
      ],
      focusedPaneId: 'pane-a',
    };

    const folderSplit = splitTabToPane(
      workspace,
      folderTabId,
      'pane-a',
      'left',
      () => 'pane-folder',
    );
    expect(folderSplit.panes[0]).toMatchObject({
      id: 'pane-folder',
      openTabs: [folderTabId],
      activeTabId: folderTabId,
      newTabIds: [],
      activeNewTabId: null,
    });
    expect(folderSplit.panes[1]).toMatchObject({
      id: 'pane-a',
      openTabs: [],
      newTabIds: [newTabId],
      activeNewTabId: newTabId,
    });

    const blankSplit = splitTabToPane(workspace, newTabId, 'pane-a', 'right', () => 'pane-blank');
    expect(blankSplit.panes[0]).toMatchObject({
      id: 'pane-a',
      openTabs: [folderTabId],
      newTabIds: [],
    });
    expect(blankSplit.panes[1]).toMatchObject({
      id: 'pane-blank',
      openTabs: [],
      activeTabId: null,
      newTabIds: [newTabId],
      activeNewTabId: newTabId,
    });
    expect(findPaneOwningTab(workspace, newTabId)?.id).toBe('pane-a');
  });

  test('moves tabs between panes, maintains pins, and clears any stale active target', () => {
    const workspace: EditorWorkspaceState = {
      panes: [
        { ...pane('pane-a', ['a', 'b'], 'b'), pinnedTabIds: ['b'] },
        pane('pane-b', ['c'], 'c'),
      ],
      focusedPaneId: 'pane-a',
    };

    const moved = moveTabToPane(workspace, 'b', 'pane-b', 1);

    expect(moved.panes).toEqual([
      { ...pane('pane-a', ['a'], 'a', 50), activeTarget: null },
      { ...pane('pane-b', ['c', 'b'], 'b', 50), pinnedTabIds: ['b'], activeTarget: null },
    ]);
    expect(moved.focusedPaneId).toBe('pane-b');
  });

  test('translates a visible insertion around interleaved blank tabs to its bucket index', () => {
    const visibleOrder = ['doc-a', 'new-tab:1', 'doc-b', 'new-tab:2'];

    expect(tabBucketIndexForVisibleInsertion([], [], 0)).toBe(0);
    expect(tabBucketIndexForVisibleInsertion(visibleOrder, ['doc-a', 'doc-b'], 0)).toBe(0);
    expect(tabBucketIndexForVisibleInsertion(visibleOrder, ['doc-a', 'doc-b'], 2)).toBe(1);
    expect(tabBucketIndexForVisibleInsertion(visibleOrder, ['new-tab:1', 'new-tab:2'], 3)).toBe(1);
    expect(tabBucketIndexForVisibleInsertion(visibleOrder, ['doc-a', 'doc-b'], 99)).toBe(2);
  });

  test('moves blank tabs between panes and activates them at the destination', () => {
    const workspace: EditorWorkspaceState = {
      panes: [
        { ...pane('pane-a', ['a'], null), newTabIds: ['new-tab:1'], activeNewTabId: 'new-tab:1' },
        pane('pane-b', ['b'], 'b'),
      ],
      focusedPaneId: 'pane-a',
    };

    const moved = moveTabToPane(workspace, 'new-tab:1', 'pane-b', 0);

    expect(moved.panes[0]).toMatchObject({
      id: 'pane-a',
      openTabs: ['a'],
      activeTabId: 'a',
      newTabIds: [],
      activeNewTabId: null,
    });
    expect(moved.panes[1]).toMatchObject({
      id: 'pane-b',
      openTabs: ['b'],
      activeTabId: null,
      newTabIds: ['new-tab:1'],
      activeNewTabId: 'new-tab:1',
      activeTarget: null,
    });
    expect(moved.focusedPaneId).toBe('pane-b');
  });

  test('reorders a tab within its current pane through the move operation', () => {
    const workspace: EditorWorkspaceState = {
      panes: [{ ...pane('pane-a', ['a', 'b', 'c'], 'b'), pinnedTabIds: ['a'] }],
      focusedPaneId: 'pane-a',
    };

    expect(moveTabToPane(workspace, 'c', 'pane-a', 0).panes[0]).toEqual({
      ...pane('pane-a', ['c', 'a', 'b'], 'b'),
      pinnedTabIds: ['c', 'a'],
    });
    expect(moveTabToPane(workspace, 'a', 'pane-a', 99).panes[0]).toEqual({
      ...pane('pane-a', ['b', 'c', 'a'], 'b'),
      pinnedTabIds: [],
    });
  });

  test('reorders tabs in one pane and adjusts only the dragged tab pin state', () => {
    const workspace: EditorWorkspaceState = {
      panes: [{ ...pane('pane-a', ['pinned', 'a', 'b'], 'a'), pinnedTabIds: ['pinned'] }],
      focusedPaneId: 'pane-a',
    };

    expect(reorderPaneTabs(workspace, 'pane-a', ['b', 'pinned', 'a'], 'b').panes[0]).toEqual({
      ...pane('pane-a', ['b', 'pinned', 'a'], 'a'),
      pinnedTabIds: ['b', 'pinned'],
    });
  });

  test('prunes empty panes, preserves one empty workspace, and focuses a surviving pane', () => {
    const workspace: EditorWorkspaceState = {
      panes: [pane('pane-a', [], null), pane('pane-b', ['b'], 'b', 25), pane('pane-c', [], null)],
      focusedPaneId: 'pane-a',
    };

    expect(pruneEmptyEditorPanes(workspace)).toEqual({
      panes: [{ ...pane('pane-b', ['b'], 'b', 100) }],
      focusedPaneId: 'pane-b',
    });
    expect(
      pruneEmptyEditorPanes({ panes: [pane('pane-a', [], null)], focusedPaneId: 'pane-a' }),
    ).toEqual(createEmptyEditorWorkspace(() => 'pane-a'));
  });

  test('projects only panes with visible tabs without deleting the saved workspace', () => {
    const workspace: EditorWorkspaceState = {
      panes: [
        pane('pane-files', ['file-a'], 'file-a', 25),
        {
          ...pane('pane-mixed', ['file-b', 'skill-b'], 'file-b', 50),
          pinnedTabIds: ['file-b', 'skill-b'],
          previewTabId: 'file-b',
        },
        pane('pane-skills', ['skill-c'], 'skill-c', 25),
      ],
      focusedPaneId: 'pane-files',
    };

    const projected = projectVisibleEditorWorkspace(
      workspace,
      new Map([
        ['pane-files', []],
        ['pane-mixed', ['skill-b']],
        ['pane-skills', ['skill-c']],
      ]),
    );

    expect(projected).toEqual({
      panes: [
        {
          ...pane('pane-mixed', ['skill-b'], 'skill-b', 100 * (2 / 3)),
          pinnedTabIds: ['skill-b'],
          activeTarget: null,
        },
        pane('pane-skills', ['skill-c'], 'skill-c', 100 * (1 / 3)),
      ],
      focusedPaneId: 'pane-mixed',
    });
    expect(workspace.panes.map((candidate) => candidate.openTabs)).toEqual([
      ['file-a'],
      ['file-b', 'skill-b'],
      ['skill-c'],
    ]);
  });

  test('projects a valid empty workspace when no pane has visible tabs', () => {
    const workspace: EditorWorkspaceState = {
      panes: [pane('pane-skills', ['skill-a'], 'skill-a')],
      focusedPaneId: 'pane-skills',
    };

    expect(projectVisibleEditorWorkspace(workspace, new Map([['pane-skills', []]]))).toEqual(
      createEmptyEditorWorkspace(() => 'pane-skills'),
    );
  });

  test('preserves a preview tab when it remains visible in the projected pane', () => {
    const workspace: EditorWorkspaceState = {
      panes: [
        {
          ...pane('pane-files', ['file-a', 'file-preview'], 'file-a'),
          previewTabId: 'file-preview',
        },
      ],
      focusedPaneId: 'pane-files',
    };

    expect(
      projectVisibleEditorWorkspace(
        workspace,
        new Map([['pane-files', ['file-a', 'file-preview']]]),
      ),
    ).toEqual(workspace);
  });

  test('closes and remaps tabs without retaining a target for a changed selection', () => {
    const workspace: EditorWorkspaceState = {
      panes: [pane('pane-a', ['a', 'b'], 'a')],
      focusedPaneId: 'pane-a',
    };

    const closed = closeTabsInPane(workspace, 'pane-a', ['a']);
    expect(closed.panes[0]).toEqual({ ...pane('pane-a', ['b'], 'b', 100), activeTarget: null });

    const remapped = remapWorkspaceTabs(
      { panes: [pane('pane-a', ['a', 'b'], 'b')], focusedPaneId: 'pane-a' },
      (tabId) => (tabId === 'b' ? 'renamed-b' : tabId),
    );
    expect(remapped.panes[0]).toEqual({
      ...pane('pane-a', ['a', 'renamed-b'], 'renamed-b', 100),
      activeTarget: null,
    });

    const duplicates = remapWorkspaceTabs(
      {
        panes: [pane('pane-a', ['a']), pane('pane-b', ['b'])],
        focusedPaneId: 'pane-a',
      },
      () => 'renamed',
    );
    expect(duplicates.panes).toEqual([
      { ...pane('pane-a', ['renamed'], 'renamed', 100), activeTarget: null },
    ]);
  });

  test('replaces only the pane preview and reports displacement without closing history', () => {
    const workspace: EditorWorkspaceState = {
      panes: [
        {
          ...pane('pane-a', ['permanent', 'preview-old'], 'permanent'),
          previewTabId: 'preview-old',
        },
      ],
      focusedPaneId: 'pane-a',
    };

    const transition = transitionEditorWorkspace(workspace, {
      type: 'open-target',
      paneId: 'pane-a',
      tabId: 'preview-new',
      target: docTarget('preview-new'),
      disposition: 'preview',
      consumeActiveNewTab: false,
    });

    expect(transition).toMatchObject({
      openedTabId: 'preview-new',
      replacedPreviewTabId: 'preview-old',
      consumedNewTabId: null,
    });
    expect(transition.workspace.panes[0]).toMatchObject({
      openTabs: ['permanent', 'preview-new'],
      activeTabId: 'preview-new',
      previewTabId: 'preview-new',
      activeTarget: docTarget('preview-new'),
    });
  });

  test('an edited preview tab survives opening the next file; an untouched one is replaced', () => {
    // The two halves of the sidebar contract. Click a file, click another: the
    // first is provisional and gives up its slot. Click a file, EDIT it, click
    // another: the edit promoted it, so it stays open. The edited bytes were
    // never at risk (they live in the CRDT), but the tab vanishing read as
    // lost work.
    const opened: EditorWorkspaceState = transitionEditorWorkspace(
      { panes: [pane('pane-a', [], null)], focusedPaneId: 'pane-a' },
      {
        type: 'open-target',
        paneId: 'pane-a',
        tabId: 'first',
        target: docTarget('first'),
        disposition: 'preview',
        consumeActiveNewTab: false,
      },
    ).workspace;
    expect(opened.panes[0]?.previewTabId).toBe('first');

    const openSecond = (workspace: EditorWorkspaceState) =>
      transitionEditorWorkspace(workspace, {
        type: 'open-target',
        paneId: 'pane-a',
        tabId: 'second',
        target: docTarget('second'),
        disposition: 'preview',
        consumeActiveNewTab: false,
      }).workspace;

    // Untouched: the preview slot is reused, so `first` is gone.
    expect(openSecond(opened).panes[0]?.openTabs).toEqual(['second']);

    // Edited: `promote-preview` is what the user-edit listener dispatches.
    const edited = transitionEditorWorkspace(opened, {
      type: 'promote-preview',
      paneId: 'pane-a',
      tabId: 'first',
    }).workspace;
    expect(edited.panes[0]?.previewTabId).toBeNull();

    const afterSecond = openSecond(edited).panes[0];
    expect(afterSecond?.openTabs).toEqual(['first', 'second']);
    expect(afterSecond?.activeTabId).toBe('second');
    // `second` takes the slot `first` vacated, so it stays provisional itself.
    expect(afterSecond?.previewTabId).toBe('second');
  });

  test('promoting a tab that is not the pane preview leaves the preview alone', () => {
    // The listener fires on every user keystroke, so the no-match path is the
    // common one — it must not clear a different tab's preview state.
    const workspace: EditorWorkspaceState = {
      panes: [
        {
          ...pane('pane-a', ['permanent', 'preview'], 'permanent'),
          previewTabId: 'preview',
        },
      ],
      focusedPaneId: 'pane-a',
    };

    const after = transitionEditorWorkspace(workspace, {
      type: 'promote-preview',
      paneId: 'pane-a',
      tabId: 'permanent',
    }).workspace;

    expect(after.panes[0]?.previewTabId).toBe('preview');
  });

  test('promotes an existing preview for permanent intent and never demotes a permanent tab', () => {
    const workspace: EditorWorkspaceState = {
      panes: [
        {
          ...pane('pane-a', ['preview'], 'preview', 50),
          previewTabId: 'preview',
        },
        pane('pane-b', ['permanent'], 'permanent', 50),
      ],
      focusedPaneId: 'pane-a',
    };

    const promoted = transitionEditorWorkspace(workspace, {
      type: 'open-target',
      paneId: 'pane-a',
      tabId: 'preview',
      target: docTarget('preview'),
      disposition: 'permanent',
      consumeActiveNewTab: false,
    });
    expect(promoted.workspace.panes[0]?.previewTabId).toBeNull();

    const existingPermanent = transitionEditorWorkspace(promoted.workspace, {
      type: 'open-target',
      paneId: 'pane-a',
      tabId: 'permanent',
      target: docTarget('permanent'),
      disposition: 'preview',
      consumeActiveNewTab: false,
    });
    expect(existingPermanent.workspace.focusedPaneId).toBe('pane-b');
    expect(existingPermanent.workspace.panes[1]).toMatchObject({
      openTabs: ['permanent'],
      activeTabId: 'permanent',
      previewTabId: null,
    });
  });

  test('opens an existing folder tab in an explicitly targeted pane without removing the other pane copy', () => {
    const fooFolderTabId = '\u0000folder:foo';
    const barFolderTabId = '\u0000folder:bar';
    const workspace: EditorWorkspaceState = {
      panes: [
        pane('pane-a', ['foo.md'], 'foo.md', 50),
        pane('pane-b', [fooFolderTabId, barFolderTabId], barFolderTabId, 50),
      ],
      focusedPaneId: 'pane-b',
    };
    const fooFolderTarget = { kind: 'folder' as const, target: 'foo', folderPath: 'foo' };

    const transition = transitionEditorWorkspace(workspace, {
      type: 'open-target',
      paneId: 'pane-a',
      tabId: fooFolderTabId,
      target: fooFolderTarget,
      disposition: 'permanent',
      consumeActiveNewTab: false,
      existingTabBehavior: 'open-in-pane',
    });

    expect(transition.workspace.focusedPaneId).toBe('pane-a');
    expect(transition.workspace.panes[0]).toMatchObject({
      id: 'pane-a',
      openTabs: ['foo.md', fooFolderTabId],
      activeTabId: fooFolderTabId,
      activeTarget: fooFolderTarget,
    });
    expect(transition.workspace.panes[1]).toMatchObject({
      id: 'pane-b',
      openTabs: [fooFolderTabId, barFolderTabId],
      activeTabId: barFolderTabId,
    });
  });

  test('preserves independent view tabs across panes while keeping document tabs unique', () => {
    const folderTabId = '\u0000folder:foo';
    const folderTarget = { kind: 'folder' as const, target: 'foo', folderPath: 'foo' };
    const workspace = normalizeEditorWorkspace({
      panes: [
        {
          ...pane('pane-a', ['foo.md', folderTabId], folderTabId, 50),
          pinnedTabIds: [folderTabId],
          activeTarget: folderTarget,
        },
        {
          ...pane('pane-b', ['foo.md', folderTabId], folderTabId, 50),
          activeTarget: folderTarget,
        },
      ],
      focusedPaneId: 'pane-b',
    });

    expect(workspace.panes).toEqual([
      {
        ...pane('pane-a', ['foo.md', folderTabId], folderTabId, 50),
        pinnedTabIds: [folderTabId],
        activeTarget: folderTarget,
      },
      {
        ...pane('pane-b', [folderTabId], folderTabId, 50),
        activeTarget: folderTarget,
      },
    ]);
    expect(parsePersistedEditorWorkspace(persistEditorWorkspace(workspace))).toEqual({
      panes: workspace.panes.map(({ id, openTabs, pinnedTabIds, activeTabId, size }) => ({
        id,
        openTabs,
        pinnedTabIds,
        activeTabId,
        size,
      })),
      focusedPaneId: 'pane-b',
    });

    const renamedFolderTabId = '\u0000folder:renamed';
    const remapped = remapWorkspaceTabs(workspace, (tabId) =>
      tabId === folderTabId ? renamedFolderTabId : tabId,
    );
    expect(
      remapped.panes.map(({ openTabs, pinnedTabIds }) => ({ openTabs, pinnedTabIds })),
    ).toEqual([
      { openTabs: ['foo.md', renamedFolderTabId], pinnedTabIds: [renamedFolderTabId] },
      { openTabs: [renamedFolderTabId], pinnedTabIds: [] },
    ]);
  });

  test('appends a permanent tab without promoting an unrelated preview', () => {
    const workspace: EditorWorkspaceState = {
      panes: [
        {
          ...pane('pane-a', ['preview'], 'preview'),
          previewTabId: 'preview',
        },
      ],
      focusedPaneId: 'pane-a',
    };

    const transition = transitionEditorWorkspace(workspace, {
      type: 'open-target',
      paneId: 'pane-a',
      tabId: 'permanent',
      target: docTarget('permanent'),
      disposition: 'permanent',
      consumeActiveNewTab: false,
    });

    expect(transition.workspace.panes[0]).toMatchObject({
      openTabs: ['preview', 'permanent'],
      activeTabId: 'permanent',
      previewTabId: 'preview',
    });
  });

  test.each([
    'preview',
    'permanent',
  ] as const)('consumes an active blank independently of %s disposition', (disposition) => {
    const workspace: EditorWorkspaceState = {
      panes: [
        {
          ...pane('pane-a', ['existing'], null),
          newTabIds: ['new-tab:1'],
          activeNewTabId: 'new-tab:1',
        },
      ],
      focusedPaneId: 'pane-a',
    };

    const transition = transitionEditorWorkspace(workspace, {
      type: 'open-target',
      paneId: 'pane-a',
      tabId: 'opened',
      target: docTarget('opened'),
      disposition,
      consumeActiveNewTab: true,
    });

    expect(transition.consumedNewTabId).toBe('new-tab:1');
    expect(transition.workspace.panes[0]).toMatchObject({
      openTabs: ['existing', 'opened'],
      newTabIds: [],
      activeNewTabId: null,
      previewTabId: disposition === 'preview' ? 'opened' : null,
    });
  });

  test('activates, creates, closes, pins, and promotes tabs through the command boundary', () => {
    let workspace: EditorWorkspaceState = {
      panes: [pane('pane-a', ['a'], 'a')],
      focusedPaneId: 'pane-a',
    };

    workspace = transitionEditorWorkspace(workspace, {
      type: 'open-new-tab',
      paneId: 'pane-a',
      tabId: 'new-tab:1',
    }).workspace;
    expect(workspace.panes[0]?.activeNewTabId).toBe('new-tab:1');

    workspace = transitionEditorWorkspace(workspace, {
      type: 'activate-tab',
      paneId: 'pane-a',
      tabId: 'a',
    }).workspace;
    expect(workspace.panes[0]).toMatchObject({ activeTabId: 'a', activeNewTabId: null });

    workspace = transitionEditorWorkspace(
      {
        ...workspace,
        panes: workspace.panes.map((pane) => ({ ...pane, previewTabId: 'a' })),
      },
      { type: 'pin-tab', paneId: 'pane-a', tabId: 'a' },
    ).workspace;
    expect(workspace.panes[0]).toMatchObject({ pinnedTabIds: ['a'], previewTabId: null });

    workspace = transitionEditorWorkspace(workspace, {
      type: 'unpin-tab',
      paneId: 'pane-a',
      tabId: 'a',
    }).workspace;
    expect(workspace.panes[0]?.pinnedTabIds).toEqual([]);

    workspace = transitionEditorWorkspace(
      {
        ...workspace,
        panes: workspace.panes.map((pane) => ({ ...pane, previewTabId: 'a' })),
      },
      { type: 'promote-preview', paneId: 'pane-a', tabId: 'a' },
    ).workspace;
    expect(workspace.panes[0]?.previewTabId).toBeNull();

    workspace = transitionEditorWorkspace(workspace, {
      type: 'close-tabs',
      paneId: 'pane-a',
      tabIds: ['new-tab:1'],
    }).workspace;
    expect(workspace.panes[0]?.newTabIds).toEqual([]);
  });

  test('routes organization commands through normalized workspace invariants', () => {
    let workspace: EditorWorkspaceState = {
      panes: [
        { ...pane('pane-a', ['a', 'b'], 'a', 50), previewTabId: 'b' },
        pane('pane-b', ['c'], 'c', 50),
      ],
      focusedPaneId: 'pane-a',
    };

    workspace = transitionEditorWorkspace(workspace, {
      type: 'reorder-tabs',
      paneId: 'pane-a',
      tabIds: ['b', 'a'],
      draggedTabId: 'b',
    }).workspace;
    expect(workspace.panes[0]).toMatchObject({
      openTabs: ['b', 'a'],
      pinnedTabIds: [],
      previewTabId: null,
    });

    workspace = transitionEditorWorkspace(workspace, {
      type: 'move-tab',
      tabId: 'b',
      paneId: 'pane-b',
      index: 1,
    }).workspace;
    expect(workspace.panes[1]?.openTabs).toEqual(['c', 'b']);

    workspace = transitionEditorWorkspace(workspace, {
      type: 'split-tab',
      tabId: 'b',
      paneId: 'pane-b',
      side: 'right',
      newPaneId: 'pane-c',
    }).workspace;
    expect(workspace.panes.map((item) => item.id)).toEqual(['pane-a', 'pane-b', 'pane-c']);

    workspace = transitionEditorWorkspace(workspace, {
      type: 'resize-panes',
      sizes: [20, 30, 50],
    }).workspace;
    expect(workspace.panes.map((item) => item.size)).toEqual([20, 30, 50]);

    workspace = transitionEditorWorkspace(workspace, {
      type: 'remap-tabs',
      remap: (tabId) => (tabId === 'b' ? 'renamed-b' : tabId),
    }).workspace;
    expect(flattenWorkspaceTabs(workspace)).toEqual(['a', 'c', 'renamed-b']);

    workspace = transitionEditorWorkspace(workspace, {
      type: 'prune-tabs',
      keep: (tabId) => tabId !== 'c',
    }).workspace;
    expect(flattenWorkspaceTabs(workspace)).toEqual(['a', 'renamed-b']);
    expect(workspace.panes.reduce((sum, item) => sum + item.size, 0)).toBeCloseTo(100);
  });

  test('promotes every preview without closing tabs', () => {
    const workspace: EditorWorkspaceState = {
      panes: [
        { ...pane('pane-a', ['a'], 'a', 50), previewTabId: 'a' },
        { ...pane('pane-b', ['b'], 'b', 50), previewTabId: 'b' },
      ],
      focusedPaneId: 'pane-a',
    };

    const promoted = transitionEditorWorkspace(workspace, { type: 'promote-all-previews' });
    expect(promoted.workspace.panes.map((item) => item.previewTabId)).toEqual([null, null]);
    expect(flattenWorkspaceTabs(promoted.workspace)).toEqual(['a', 'b']);
    expect(promoted.replacedPreviewTabId).toBeNull();
  });

  test('records recently closed tabs once per tab and bounds history', () => {
    const entries = recordRecentlyClosedTab(
      recordRecentlyClosedTab([], { paneId: 'pane-a', tabId: 'a' }),
      { paneId: 'pane-b', tabId: 'a' },
      2,
    );

    expect(entries).toEqual([{ paneId: 'pane-b', tabId: 'a' }]);
    expect(recordRecentlyClosedTab(entries, { paneId: 'pane-a', tabId: 'b' }, 1)).toEqual([
      { paneId: 'pane-a', tabId: 'b' },
    ]);
  });

  test('accepts 25 persisted panes without applying an editor-count cap', () => {
    const restored = parsePersistedEditorWorkspace({
      panes: Array.from({ length: 25 }, (_, index) => ({
        id: `pane-${index}`,
        openTabs: [`doc-${index}`],
        pinnedTabIds: [],
        activeTabId: `doc-${index}`,
        size: 1,
      })),
      focusedPaneId: 'pane-24',
    });

    expect(restored.panes).toHaveLength(25);
    expect(restored.focusedPaneId).toBe('pane-24');
    expect(restored.panes.reduce((sum, item) => sum + item.size, 0)).toBeCloseTo(100);
    expect(
      persistEditorWorkspace({
        ...restored,
        panes: restored.panes.map((item) => ({
          ...item,
          previewTabId: null,
          newTabIds: [],
          activeNewTabId: null,
          activeTarget: null,
        })),
      }),
    ).toEqual(restored);
  });

  test('does not focus an unknown pane', () => {
    const workspace = createEmptyEditorWorkspace(() => 'pane-a');
    expect(focusEditorPane(workspace, 'missing')).toBe(workspace);
  });

  test('clears previewTabId when the preview tab is renamed to a different id', () => {
    const workspace: EditorWorkspaceState = {
      panes: [
        {
          ...pane('pane-a', ['preview', 'other'], 'preview'),
          previewTabId: 'preview',
        },
      ],
      focusedPaneId: 'pane-a',
    };
    const remapped = remapWorkspaceTabs(workspace, (tabId) =>
      tabId === 'preview' ? 'renamed-preview' : tabId,
    );
    expect(remapped.panes[0]?.previewTabId).toBeNull();
    expect(remapped.panes[0]?.openTabs).toContain('renamed-preview');
  });

  test('resize-panes returns unchanged workspace on mismatched count or invalid sizes', () => {
    const workspace: EditorWorkspaceState = {
      panes: [pane('pane-a', ['a'], 'a', 50), pane('pane-b', ['b'], 'b', 50)],
      focusedPaneId: 'pane-a',
    };

    const mismatch = transitionEditorWorkspace(workspace, {
      type: 'resize-panes',
      sizes: [100],
    });
    expect(mismatch.workspace).toBe(workspace);

    const nanSizes = transitionEditorWorkspace(workspace, {
      type: 'resize-panes',
      sizes: [NaN, 50],
    });
    expect(nanSizes.workspace).toBe(workspace);

    const zeroSize = transitionEditorWorkspace(workspace, {
      type: 'resize-panes',
      sizes: [0, 50],
    });
    expect(zeroSize.workspace).toBe(workspace);
  });
});
