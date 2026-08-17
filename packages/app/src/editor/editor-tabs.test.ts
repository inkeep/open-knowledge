import { describe, expect, test, vi } from 'vitest';
import {
  addPinnedTab,
  applyDragPinMutation,
  assetTabId,
  createEditorTabSessionState,
  docNameForTabId,
  docTabId,
  filterClosableTabIds,
  filterOpenTabsForKnownTargets,
  findLocalSkillPreviewTabId,
  folderTabId,
  isSkillBundleShapedPath,
  isSkillDocName,
  isSkillTabId,
  localTabSessionKeyForMode,
  localTabSessionStorageKey,
  nextActiveTabAfterClose,
  nextActiveTabAfterCloseMany,
  normalizeOpenTabs,
  normalizePinnedTabIds,
  parseEditorTabId,
  parseEditorTabSessionState,
  readLocalTabSessionState,
  reconcileVisibleTabOrder,
  remapOpenTabs,
  remapVisibleTabsForRename,
  removeOpenTab,
  removePinnedTab,
  shouldPersistTabSession,
  skillFileTabId,
  skillPreviewTabId,
  tabIdForNavigationTarget,
  tabParts,
  writeLocalTabSessionState,
} from './editor-tabs';

function createMemoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function persistedWorkspace(
  openTabs: string[],
  pinnedTabIds: string[],
  activeTabId: string | null,
) {
  return {
    activeTabByMode: { files: null, skills: null },
    panes: [
      {
        id: 'pane-main',
        openTabs,
        pinnedTabIds,
        activeTabId,
        size: 100,
      },
    ],
    focusedPaneId: 'pane-main',
  };
}

function editorWorkspace(openTabs: string[], pinnedTabIds: string[], activeTabId: string | null) {
  return {
    panes: [
      {
        ...persistedWorkspace(openTabs, pinnedTabIds, activeTabId).panes[0],
        previewTabId: null,
        newTabIds: [],
        activeNewTabId: null,
        activeTarget: null,
      },
    ],
    focusedPaneId: 'pane-main',
  };
}

function withConsoleWarnStub(fn: (warn: ReturnType<typeof vi.fn>) => void) {
  const originalWarn = console.warn;
  const warn = vi.fn(() => {});
  console.warn = warn as unknown as typeof console.warn;
  try {
    fn(warn);
  } finally {
    console.warn = originalWarn;
  }
}

describe('editor tab state', () => {
  test('normalizes persisted tabs by filtering invalid and duplicate entries', () => {
    expect(normalizeOpenTabs(['a', '', 'a', 'b', 42, 'c'], 3)).toEqual(['a', 'b', 'c']);
  });

  test('normalizes folder tabs alongside document tabs', () => {
    const folder = folderTabId('docs/guides');
    expect(normalizeOpenTabs(['a', folder, folder, 42, 'b'], 10)).toEqual(['a', folder, 'b']);
  });

  test('normalizes asset tabs alongside document tabs', () => {
    const asset = assetTabId('docs/photo.png');
    expect(normalizeOpenTabs(['a', asset, asset, 42, 'b'], 10)).toEqual(['a', asset, 'b']);
  });

  test('normalizes pinned tabs against the open tab set', () => {
    expect(normalizePinnedTabIds(['b', 'missing', 'b', '', 42], ['a', 'b', 'c'])).toEqual(['b']);
  });

  test('adds and removes pinned tabs only when the tab is open', () => {
    expect(addPinnedTab(['a'], 'b', ['a', 'b'])).toEqual(['a', 'b']);
    expect(addPinnedTab(['a'], 'missing', ['a', 'b'])).toEqual(['a']);
    expect(removePinnedTab(['a', 'b'], 'a')).toEqual(['b']);
  });

  test('filters close batches so pinned tabs survive close-all and close-others actions', () => {
    expect(filterClosableTabIds(['a', 'b', 'c', 'b'], ['b'])).toEqual(['a', 'c']);
  });

  test('derives tab ids for document, folder, and asset navigation targets', () => {
    expect(tabIdForNavigationTarget({ kind: 'doc', target: 'docs/a', docName: 'docs/a' })).toBe(
      docTabId('docs/a'),
    );
    expect(
      tabIdForNavigationTarget({
        kind: 'folder',
        target: 'docs',
        folderPath: 'docs',
      }),
    ).toBe(folderTabId('docs'));
    expect(
      tabIdForNavigationTarget({
        kind: 'asset',
        target: 'docs/photo.png',
        assetPath: 'docs/photo.png',
      }),
    ).toBe(assetTabId('docs/photo.png'));
    expect(tabIdForNavigationTarget({ kind: 'skills', target: 'skills' })).toBeNull();
  });

  test('parses tab ids back to their navigation payload', () => {
    expect(parseEditorTabId(docTabId('docs/a'))).toEqual({ kind: 'doc', docName: 'docs/a' });
    expect(parseEditorTabId(folderTabId('docs'))).toEqual({
      kind: 'folder',
      folderPath: 'docs',
    });
    expect(parseEditorTabId(assetTabId('docs/photo.png'))).toEqual({
      kind: 'asset',
      assetPath: 'docs/photo.png',
    });
    expect(docNameForTabId(folderTabId('docs'))).toBeNull();
    expect(docNameForTabId(assetTabId('docs/photo.png'))).toBeNull();
    expect(parseEditorTabId('skills:hub')).toEqual({ kind: 'doc', docName: 'skills:hub' });
  });

  test('round-trips a skill-file tab id (scope / name / nested path)', () => {
    const tabId = skillFileTabId({ scope: 'global', name: 'trip-log', path: 'references/x.md' });
    expect(parseEditorTabId(tabId)).toEqual({
      kind: 'skill-file',
      scope: 'global',
      name: 'trip-log',
      path: 'references/x.md',
    });
    expect(docNameForTabId(tabId)).toBeNull();
  });

  test('a skill-file tab id with an unknown scope is not parsed as a skill-file', () => {
    // The scope segment must be a real skill scope — a hand-edited / stale tab id
    // with a bogus scope falls through to a docName rather than a bogus target.
    const bogus = `\u0000skill-file:personal/trip-log/references/x.md`;
    expect(parseEditorTabId(bogus).kind).toBe('doc');
  });

  test('removeOpenTab removes only the requested tab', () => {
    expect(removeOpenTab(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  test('reconcileVisibleTabOrder preserves interleaved blank-tab positions', () => {
    expect(
      reconcileVisibleTabOrder(['doc-a', 'new-tab:1', 'doc-b'], ['doc-a', 'doc-b'], ['new-tab:1']),
    ).toEqual(['doc-a', 'new-tab:1', 'doc-b']);
  });

  test('reconcileVisibleTabOrder appends newly-created ids and drops stale ids', () => {
    expect(
      reconcileVisibleTabOrder(
        ['stale-doc', 'doc-a', 'new-tab:1', 'stale-new'],
        ['doc-a', 'doc-b'],
        ['new-tab:1', 'new-tab:2'],
      ),
    ).toEqual(['doc-a', 'new-tab:1', 'doc-b', 'new-tab:2']);
  });

  test('filterOpenTabsForKnownTargets drops stale folder tabs', () => {
    expect(
      filterOpenTabsForKnownTargets(
        ['docs/a', folderTabId('hello'), folderTabId('hello2'), 'missing'],
        {
          pages: new Set(['docs/a']),
          folderPaths: new Set(['hello']),
          assetPaths: new Set(),
        },
      ),
    ).toEqual(['docs/a', folderTabId('hello')]);
  });

  test('filterOpenTabsForKnownTargets keeps the SKILL doc that left the page list', () => {
    // A scope move deletes the source bundle BEFORE its response lands, so the
    // source doc stops being a page mid-move. Pruning it there closed the tab
    // `useMoveSkillScope` was about to repoint; the retarget then matched no
    // open tab, did nothing, and the skill could not be opened until a reload.
    // The skills reconciler owns this doc's lifecycle instead.
    expect(
      filterOpenTabsForKnownTargets(['.claude/skills/demo/SKILL', 'docs/a', 'deleted'], {
        pages: new Set(['docs/a']),
        folderPaths: new Set(),
        assetPaths: new Set(),
      }),
    ).toEqual(['.claude/skills/demo/SKILL', 'docs/a']);
  });

  test('filterOpenTabsForKnownTargets still prunes a bundle FILE tab', () => {
    // Deliberately NOT exempt. The reconciler keeps any tab whose SKILL still
    // exists, so it will never close a `references/*` doc deleted out of band
    // (an agent, MCP, another client). The page list is that file's only
    // closer; exempting it would leave a live provider on a deleted file, and
    // typing into that tab would rematerialise it on disk.
    expect(
      filterOpenTabsForKnownTargets(['.claude/skills/demo/references/notes'], {
        pages: new Set(),
        folderPaths: new Set(),
        assetPaths: new Set(),
      }),
    ).toEqual([]);
  });

  test('filterOpenTabsForKnownTargets does not exempt a shape the reconciler cannot parse', () => {
    // A symlinked bundle's canonical doc (`plugins/x/skills/<name>/SKILL`) is a
    // REAL page, so it needs no exemption — and exempting it would be worse than
    // useless: `parseSkillTabDocName` cannot read that shape, so nothing could
    // ever close the tab once the skill was deleted.
    expect(
      filterOpenTabsForKnownTargets(['plugins/ok/skills/demo/SKILL'], {
        pages: new Set(),
        folderPaths: new Set(),
        assetPaths: new Set(),
      }),
    ).toEqual([]);
    expect(
      filterOpenTabsForKnownTargets(['plugins/ok/skills/demo/SKILL'], {
        pages: new Set(['plugins/ok/skills/demo/SKILL']),
        folderPaths: new Set(),
        assetPaths: new Set(),
      }),
    ).toEqual(['plugins/ok/skills/demo/SKILL']);
  });

  test('filterOpenTabsForKnownTargets preserves the active missing document draft', () => {
    expect(
      filterOpenTabsForKnownTargets(['docs/a', 'Untitled', 'deleted'], {
        pages: new Set(['docs/a']),
        folderPaths: new Set(),
        assetPaths: new Set(),
        keepMissingDocName: 'Untitled',
      }),
    ).toEqual(['docs/a', 'Untitled']);
  });

  test('filterOpenTabsForKnownTargets keeps the hash doc even when absent from pages', () => {
    // Cold-start race: the page list arrives empty-then-populated, so a sync
    // firing while `pages` is still empty must not evict the doc the hash points
    // at (which would clear the hash → empty-state splash). Unlike
    // keepMissingDocName, this protects the doc BEFORE the nav effect resolves it
    // to a `missing` target.
    expect(
      filterOpenTabsForKnownTargets(['event_watcher'], {
        pages: new Set(),
        folderPaths: new Set(),
        assetPaths: new Set(),
        keepHashDocName: 'event_watcher',
      }),
    ).toEqual(['event_watcher']);
    // It only spares the hash doc — genuinely stale siblings are still pruned.
    expect(
      filterOpenTabsForKnownTargets(['event_watcher', 'old-doc'], {
        pages: new Set(),
        folderPaths: new Set(),
        assetPaths: new Set(),
        keepHashDocName: 'event_watcher',
      }),
    ).toEqual(['event_watcher']);
  });

  test('filterOpenTabsForKnownTargets keeps a managed skill tab and a template content tab', () => {
    // A global skill never appears in `pages` (managed); a template content doc
    // lands in `pages` only after the async `files` refetch. The filter must keep
    // both regardless — and unlike `keepHashDocName`, the protection holds even
    // when the hash points elsewhere, so the tab survives opening a regular doc
    // during the index-lag window.
    expect(
      filterOpenTabsForKnownTargets(['__skill__/global/foo', 'notes/.ok/templates/daily', 'gone'], {
        pages: new Set(),
        folderPaths: new Set(),
        assetPaths: new Set(),
        keepHashDocName: 'some-other-doc',
      }),
    ).toEqual(['__skill__/global/foo', 'notes/.ok/templates/daily']);
  });

  test('filterOpenTabsForKnownTargets keeps a template content tab once it lands in pages', () => {
    expect(
      filterOpenTabsForKnownTargets(['docs/.ok/templates/spec'], {
        pages: new Set(['docs/.ok/templates/spec']),
        folderPaths: new Set(),
        assetPaths: new Set(),
      }),
    ).toEqual(['docs/.ok/templates/spec']);
  });

  test('filterOpenTabsForKnownTargets drops stale asset tabs', () => {
    expect(
      filterOpenTabsForKnownTargets(
        ['docs/a', assetTabId('docs/photo.png'), assetTabId('docs/deleted.png')],
        {
          pages: new Set(['docs/a']),
          folderPaths: new Set(),
          assetPaths: new Set(['docs/photo.png']),
        },
      ),
    ).toEqual(['docs/a', assetTabId('docs/photo.png')]);
  });

  test('filterOpenTabsForKnownTargets keeps generic file tabs from filePaths', () => {
    expect(
      filterOpenTabsForKnownTargets(
        ['docs/a', assetTabId('LICENSE'), assetTabId('pnpm-workspace.yaml')],
        {
          pages: new Set(['docs/a']),
          folderPaths: new Set(),
          assetPaths: new Set(),
          filePaths: new Set(['LICENSE', 'pnpm-workspace.yaml']),
        },
      ),
    ).toEqual(['docs/a', assetTabId('LICENSE'), assetTabId('pnpm-workspace.yaml')]);
  });

  test('remapOpenTabs preserves tab order and dedupes renamed destinations', () => {
    expect(
      remapOpenTabs(
        ['docs/a', 'docs/b', 'other'],
        [
          { fromDocName: 'docs/a', toDocName: 'notes/a' },
          { fromDocName: 'docs/b', toDocName: 'other' },
        ],
        10,
      ),
    ).toEqual(['notes/a', 'other']);
  });

  test('remapOpenTabs remaps folder tabs after folder rename', () => {
    expect(
      remapOpenTabs(
        [
          folderTabId('docs'),
          folderTabId('docs/guides'),
          assetTabId('docs/guides/photo.png'),
          'docs/guides/a',
        ],
        [{ fromDocName: 'docs/guides/a', toDocName: 'notes/guides/a' }],
        10,
        [{ fromPath: 'docs', toPath: 'notes' }],
      ),
    ).toEqual([
      folderTabId('notes'),
      folderTabId('notes/guides'),
      assetTabId('notes/guides/photo.png'),
      'notes/guides/a',
    ]);
  });

  test('remapOpenTabs remaps asset tabs after asset rename', () => {
    expect(
      remapOpenTabs(
        [assetTabId('docs/photo.png'), 'docs/a'],
        [],
        10,
        [],
        [],
        [{ fromPath: 'docs/photo.png', toPath: 'assets/hero.png' }],
      ),
    ).toEqual([assetTabId('assets/hero.png'), 'docs/a']);
  });

  test('remapOpenTabs converts document tabs after document-to-file rename', () => {
    expect(
      remapOpenTabs(
        ['docs/a', 'docs/b'],
        [],
        10,
        [],
        [],
        [{ fromPath: 'docs/a.md', toPath: 'docs/a.txt' }],
      ),
    ).toEqual([assetTabId('docs/a.txt'), 'docs/b']);
  });

  test('remapOpenTabs converts asset tabs after file-to-document rename', () => {
    expect(
      remapOpenTabs(
        [assetTabId('docs/a.txt'), 'docs/b'],
        [],
        10,
        [],
        [],
        [{ fromPath: 'docs/a.txt', toPath: 'docs/a.md' }],
      ),
    ).toEqual(['docs/a', 'docs/b']);
  });

  test('remapOpenTabs preserves pinned tabs while capping unpinned tabs', () => {
    expect(
      remapOpenTabs(
        ['pinned', 'a', 'b'],
        [{ fromDocName: 'pinned', toDocName: 'renamed' }],
        1,
        [],
        ['pinned'],
      ),
    ).toEqual(['renamed', 'b']);
  });

  // remapVisibleTabsForRename is the structural guarantee used by BOTH rename
  // call sites in DocumentContext — server-driven onRenameRedirect and
  // sidebar-driven remapTabsForRename. The helper exists so the visible tab
  // order survives a rename WITHOUT re-deriving via reconcileVisibleTabOrder,
  // which would drop the stale tabId at the membership check and re-append the
  // new tabId at the end (shifting the renamed tab's slot). Tests here exercise
  // the helper directly — the dom integration tests cover the call-site wiring.
  test('remapVisibleTabsForRename — doc rename preserves slot order', () => {
    expect(
      remapVisibleTabsForRename(
        ['foo.md', 'bar.md', 'baz.md'],
        [{ fromDocName: 'foo.md', toDocName: 'bazz.md' }],
      ),
    ).toEqual(['bazz.md', 'bar.md', 'baz.md']);
  });

  test('remapVisibleTabsForRename — uncapped (no limit applied to visible tabs)', () => {
    // visibleTabIds is a derived view of openTabs + newTabIds — capping happens
    // elsewhere. The helper passes Number.MAX_SAFE_INTEGER to remapOpenTabs so
    // long visible-tab lists are not truncated mid-rename.
    const many = Array.from({ length: 100 }, (_, i) => `doc${i}.md`);
    const result = remapVisibleTabsForRename(many, [
      { fromDocName: 'doc0.md', toDocName: 'renamed0.md' },
      { fromDocName: 'doc99.md', toDocName: 'renamed99.md' },
    ]);
    expect(result).toHaveLength(100);
    expect(result[0]).toBe('renamed0.md');
    expect(result[99]).toBe('renamed99.md');
    expect(result.slice(1, 99)).toEqual(many.slice(1, 99));
  });

  test('remapVisibleTabsForRename — folder rename remaps every nested visible tab', () => {
    expect(
      remapVisibleTabsForRename(
        [folderTabId('docs'), folderTabId('docs/guides'), 'docs/guides/a.md', 'other.md'],
        [{ fromDocName: 'docs/guides/a.md', toDocName: 'notes/guides/a.md' }],
        [{ fromPath: 'docs', toPath: 'notes' }],
      ),
    ).toEqual([folderTabId('notes'), folderTabId('notes/guides'), 'notes/guides/a.md', 'other.md']);
  });

  test('remapVisibleTabsForRename — asset rename remaps asset visible tabs', () => {
    expect(
      remapVisibleTabsForRename(
        [assetTabId('docs/photo.png'), 'other.md'],
        [],
        [],
        [{ fromPath: 'docs/photo.png', toPath: 'assets/hero.png' }],
      ),
    ).toEqual([assetTabId('assets/hero.png'), 'other.md']);
  });

  test('remapVisibleTabsForRename — multiple renames apply atomically', () => {
    expect(
      remapVisibleTabsForRename(
        ['a.md', 'b.md', 'c.md'],
        [
          { fromDocName: 'a.md', toDocName: 'x.md' },
          { fromDocName: 'c.md', toDocName: 'z.md' },
        ],
      ),
    ).toEqual(['x.md', 'b.md', 'z.md']);
  });

  test('remapVisibleTabsForRename — empty rename list is a no-op', () => {
    expect(remapVisibleTabsForRename(['a.md', 'b.md'], [])).toEqual(['a.md', 'b.md']);
  });

  test('remapVisibleTabsForRename — new-tab placeholder is preserved through rename', () => {
    expect(
      remapVisibleTabsForRename(
        ['foo.md', 'new-tab:1', 'bar.md'],
        [{ fromDocName: 'foo.md', toDocName: 'bazz.md' }],
      ),
    ).toEqual(['bazz.md', 'new-tab:1', 'bar.md']);
  });

  test('nextActiveTabAfterClose prefers the tab to the right, then left', () => {
    expect(nextActiveTabAfterClose(['a', 'b', 'c'], 'b', 'b')).toBe('c');
    expect(nextActiveTabAfterClose(['a', 'b'], 'b', 'b')).toBe('a');
    expect(nextActiveTabAfterClose(['a'], 'a', 'a')).toBeNull();
  });

  test('nextActiveTabAfterClose preserves active tab when closing an inactive tab', () => {
    expect(nextActiveTabAfterClose(['a', 'b', 'c'], 'a', 'c')).toBe('a');
  });

  test('nextActiveTabAfterCloseMany chooses the nearest surviving tab', () => {
    expect(nextActiveTabAfterCloseMany(['a', 'b', 'c', 'd'], 'b', ['b', 'c'])).toBe('d');
    expect(nextActiveTabAfterCloseMany(['a', 'b', 'c'], 'c', ['b', 'c'])).toBe('a');
    expect(nextActiveTabAfterCloseMany(['a', 'b'], 'a', ['a', 'b'])).toBeNull();
  });

  test('nextActiveTabAfterCloseMany preserves active tab when it survives', () => {
    expect(nextActiveTabAfterCloseMany(['a', 'b', 'c'], 'a', ['b', 'c'])).toBe('a');
  });

  test('parseEditorTabSessionState falls back when the active tab is not open', () => {
    expect(
      parseEditorTabSessionState({
        ...persistedWorkspace(['a', 'b'], [], 'missing'),
        updatedAt: '2026-05-06T00:00:00Z',
      }),
    ).toEqual({
      updatedAt: '2026-05-06T00:00:00Z',
      ...persistedWorkspace(['a', 'b'], [], 'a'),
    });
  });

  test('parseEditorTabSessionState preserves all persisted pane tabs', () => {
    expect(
      parseEditorTabSessionState({
        ...persistedWorkspace(['pinned', 'a', 'b', 'c'], ['pinned'], 'c'),
        updatedAt: '2026-05-06T00:00:00Z',
      }),
    ).toEqual({
      updatedAt: '2026-05-06T00:00:00Z',
      ...persistedWorkspace(['pinned', 'a', 'b', 'c'], ['pinned'], 'c'),
    });
  });

  test('parseEditorTabSessionState ignores flat legacy session fields', () => {
    expect(
      parseEditorTabSessionState({
        openTabs: ['a', 'b'],
        pinnedTabIds: ['a'],
        activeDocName: 'b',
        activeTabId: 'b',
        updatedAt: '2026-05-06T00:00:00Z',
      }),
    ).toEqual({
      updatedAt: null,
      ...persistedWorkspace([], [], null),
    });
  });

  test('parseEditorTabSessionState drops legacy occurrence ids without transforming them', () => {
    expect(
      parseEditorTabSessionState({
        panes: [
          {
            id: 'pane-a',
            openTabs: ['docs/a', 'docs/a\u0000doc-tab:1', 'docs/b'],
            pinnedTabIds: ['docs/a'],
            activeTabId: 'docs/a',
            size: 1,
          },
          {
            id: 'pane-b',
            openTabs: ['docs/b\u0000doc-tab:1', 'docs/c'],
            pinnedTabIds: ['docs/b\u0000doc-tab:1', 'docs/c'],
            activeTabId: 'docs/c',
            size: 1,
          },
        ],
        focusedPaneId: 'pane-b',
        updatedAt: '2026-05-06T00:00:00Z',
      }),
    ).toEqual({
      activeTabByMode: { files: null, skills: null },
      updatedAt: '2026-05-06T00:00:00Z',
      panes: [
        {
          id: 'pane-a',
          openTabs: ['docs/a', 'docs/b'],
          pinnedTabIds: ['docs/a'],
          activeTabId: 'docs/a',
          size: 50,
        },
        {
          id: 'pane-b',
          openTabs: ['docs/c'],
          pinnedTabIds: ['docs/c'],
          activeTabId: 'docs/c',
          size: 50,
        },
      ],
      focusedPaneId: 'pane-b',
    });
  });

  test('createEditorTabSessionState timestamps serializable state', () => {
    const state = createEditorTabSessionState(
      editorWorkspace(['a', 'b'], ['a'], 'b'),
      { files: null, skills: null },
      () => new Date('2026-05-06T00:00:00Z'),
    );
    expect(state).toEqual({
      updatedAt: '2026-05-06T00:00:00.000Z',
      ...persistedWorkspace(['a', 'b'], ['a'], 'b'),
    });
  });

  test('a note window gets no local tab-session key, so it cannot clobber the editor window', () => {
    // Every desktop window shares one `file://` origin, so a popped-out note
    // window writing the origin-derived key would overwrite the main editor
    // window's tabs. Single-document windows persist nothing at all.
    expect(localTabSessionKeyForMode('note', 'file://')).toBeNull();
  });

  test('a desktop editor window gets no local key either (it persists via the bridge)', () => {
    expect(localTabSessionKeyForMode('editor', 'file://')).toBeNull();
  });

  test('the browser host still gets the origin-derived key', () => {
    expect(localTabSessionKeyForMode(undefined, 'http://localhost:5173')).toBe(
      localTabSessionStorageKey('http://localhost:5173'),
    );
  });

  test('local tab session storage round-trips serializable state', () => {
    const storage = createMemoryStorage();
    const key = localTabSessionStorageKey('http://localhost:5173');
    const state = {
      updatedAt: '2026-05-06T00:00:00.000Z',
      ...persistedWorkspace(['docs/a', 'docs/b'], ['docs/a'], 'docs/b'),
    };

    writeLocalTabSessionState(storage, key, state);

    expect(readLocalTabSessionState(storage, key)).toEqual(state);
  });

  test('local tab session storage returns empty state for corrupted JSON', () => {
    withConsoleWarnStub((warn) => {
      const storage: Pick<Storage, 'getItem'> = {
        getItem: () => '{not-json',
      };

      expect(readLocalTabSessionState(storage, 'key')).toEqual({
        updatedAt: null,
        ...persistedWorkspace([], [], null),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe('[editor-tabs] failed to read local tab session:');
    });
  });

  test('local tab session storage write swallows quota failures', () => {
    withConsoleWarnStub((warn) => {
      const storage: Pick<Storage, 'setItem'> = {
        setItem: () => {
          throw new Error('quota exceeded');
        },
      };

      expect(() =>
        writeLocalTabSessionState(storage, 'key', {
          activeTabByMode: { files: null, skills: null },
          updatedAt: '2026-05-06T00:00:00.000Z',
          ...persistedWorkspace(['docs/a'], [], 'docs/a'),
        }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe('[editor-tabs] failed to write local tab session:');
    });
  });

  test('readLocalTabSessionState returns empty state when storage is null', () => {
    // The null parameter exists for defensive programming (e.g. SSR where
    // sessionStorage is absent). Pin the guard so a future refactor that
    // drops the null-check can't silently throw on every read.
    expect(readLocalTabSessionState(null, 'key')).toEqual({
      updatedAt: null,
      ...persistedWorkspace([], [], null),
    });
  });

  test('writeLocalTabSessionState is a silent no-op when storage is null', () => {
    expect(() =>
      writeLocalTabSessionState(null, 'key', {
        activeTabByMode: { files: null, skills: null },
        updatedAt: '2026-05-06T00:00:00.000Z',
        ...persistedWorkspace(['docs/a'], [], 'docs/a'),
      }),
    ).not.toThrow();
  });
});

describe('preview-tab integration', () => {
  test('skill preview ids round-trip and classify as Skills tabs', () => {
    const target = {
      flavor: 'detected' as const,
      source: '/Users/me/.ok/skills/1on1',
      name: '1on1',
      subtitle: 'claude',
      level: 'project' as const,
    };
    const tabId = skillPreviewTabId(target);

    expect(parseEditorTabId(tabId)).toEqual({ kind: 'skill-preview', ...target });
    expect(isSkillTabId(tabId)).toBe(true);
  });

  test('local skill previews deduplicate across source-path drift', () => {
    const first = skillPreviewTabId({
      flavor: 'builtin',
      source: '/a/.ok/skills/write-skill',
      name: 'write-skill',
      subtitle: '',
      level: 'global',
    });
    const second = skillPreviewTabId({
      flavor: 'builtin',
      source: '/b/.ok/skills/write-skill',
      name: 'write-skill',
      subtitle: '',
      level: 'global',
    });

    expect(findLocalSkillPreviewTabId([first, second], 'builtin', 'write-skill', 'global')).toBe(
      first,
    );
  });

  test('session persistence waits after a failed empty restore but resumes after a tab opens', () => {
    expect(shouldPersistTabSession('unread', 0)).toBe(false);
    expect(shouldPersistTabSession('unread', 1)).toBe(true);
    expect(shouldPersistTabSession('applied', 0)).toBe(true);
  });

  test('a suppressed restore never persists, however many tabs the user opens', () => {
    // The count-based escape hatch above exists for a session we could not
    // read. A suppressed one IS readable and intact, so opening tabs in the
    // recovered workspace must never earn the right to replace it.
    expect(shouldPersistTabSession('suppressed', 0)).toBe(false);
    expect(shouldPersistTabSession('suppressed', 1)).toBe(false);
    expect(shouldPersistTabSession('suppressed', 12)).toBe(false);
  });

  test('workspace sessions preserve the active tab for each surface', () => {
    const fileTab = docTabId('docs/a');
    const skillTab = skillPreviewTabId({
      flavor: 'explore',
      source: 'owner/repo',
      name: 'review',
      subtitle: 'owner/repo',
      level: 'project',
    });
    const state = createEditorTabSessionState(
      editorWorkspace([fileTab, skillTab], [], skillTab),
      { files: fileTab, skills: skillTab },
      () => new Date('2026-05-06T00:00:00Z'),
    );

    expect(parseEditorTabSessionState(state).activeTabByMode).toEqual({
      files: fileTab,
      skills: skillTab,
    });
  });
});

describe('applyDragPinMutation — drag-mutable pin state', () => {
  test('pinned tab dragged out of the (size-1) pinned zone unpins; only it changes', () => {
    // [A,B,C] pinned {A}. Divide after position 0. Drag A to index 1 → A is
    // now in the unpinned region → unpin. B,C untouched.
    expect(applyDragPinMutation(['B', 'A', 'C'], ['A'], 'A')).toEqual([]);
  });

  test('unpinned tab dragged into the pinned zone pins; others keep state', () => {
    // [A,B,C,D] pinned {A,B} (zone = first 2). Drag D to front → D at index 0
    // is inside the zone → pin D. A,B stay pinned even though B slid out of
    // the first-2 positions (pin is membership, not position).
    expect(applyDragPinMutation(['D', 'A', 'B', 'C'], ['A', 'B'], 'D')).toEqual(['A', 'B', 'D']);
  });

  test('pinned tab dragged past the divide into the unpinned region unpins', () => {
    // [A,B,C,D] pinned {A,B} (zone = first 2). Drag A to index 2 → outside the
    // zone → unpin A. B stays pinned.
    expect(applyDragPinMutation(['B', 'C', 'A', 'D'], ['A', 'B'], 'A')).toEqual(['B']);
  });

  test('swapping two pinned tabs within the zone keeps both pinned', () => {
    // [A,B,C,D] pinned {A,B}. Swap A,B → [B,A,C,D]. Dragged A still at index 1
    // (< pinnedCount 2) → no flip. Regression guard against unpinning on a
    // benign intra-pin reorder.
    expect(applyDragPinMutation(['B', 'A', 'C', 'D'], ['A', 'B'], 'A')).toEqual(['A', 'B']);
  });

  test('reordering unpinned tabs among themselves never touches pin state', () => {
    // [A,B,C,D] pinned {A,B}. Swap C,D → [A,B,D,C], dragged C stays outside
    // the zone (index 3 ≥ 2) and was already unpinned → no change.
    expect(applyDragPinMutation(['A', 'B', 'D', 'C'], ['A', 'B'], 'C')).toEqual(['A', 'B']);
  });

  test('with no pinned tabs, dragging any tab cannot pin it (no pinned position to cross)', () => {
    expect(applyDragPinMutation(['C', 'A', 'B'], [], 'C')).toEqual([]);
  });

  test('dragged id that is not an open tab (placeholder/unknown) never mutates pin state', () => {
    expect(applyDragPinMutation(['A', 'B'], ['A'], 'new-tab:placeholder')).toEqual(['A']);
  });

  test('normalizes inputs: stale pinned ids not in openTabs are dropped', () => {
    // 'Z' is pinned but no longer open → normalized away; A stays pinned
    // (index 0 < pinnedCount 1 after normalization).
    expect(applyDragPinMutation(['A', 'B'], ['A', 'Z'], 'B')).toEqual(['A']);
  });
});

describe('tabParts — non-`.md` call-site shapes (folder + asset)', () => {
  // Production call sites in EditorTabs.tsx invoke `tabParts` with three docExt
  // shapes: `'.md'` for doc tabs, `'/'` for folder tabs, `''` for asset tabs.
  // The `.md` shape is exercised throughout the rest of this file; these pin
  // the other two so a future refactor that normalizes docExt (e.g. trimming
  // trailing `/`) can't silently break folder/asset labels.

  test('folder shape: docExt `/` produces baseName-with-trailing-slash label', () => {
    expect(tabParts('docs/guides', '/')).toEqual({
      baseName: 'guides',
      extension: '/',
      label: 'guides/',
      prefix: 'docs/',
    });
  });

  test('asset shape: docExt empty string produces label equal to baseName', () => {
    expect(tabParts('images/cat.jpg', '')).toEqual({
      baseName: 'cat.jpg',
      extension: '',
      label: 'cat.jpg',
      prefix: 'images/',
    });
  });

  test('document shape: extension-qualified docName does not duplicate the extension', () => {
    expect(tabParts('docs/guide.md', '.md')).toEqual({
      baseName: 'guide.md',
      extension: '',
      label: 'guide.md',
      prefix: 'docs/',
    });
  });

  test('document shape: extension-qualified .mdx docName does not duplicate the extension', () => {
    expect(tabParts('docs/guide.mdx', '.mdx')).toEqual({
      baseName: 'guide.mdx',
      extension: '',
      label: 'guide.mdx',
      prefix: 'docs/',
    });
  });

  test('folder shape at top-level (no slash) has empty prefix', () => {
    expect(tabParts('drafts', '/')).toEqual({
      baseName: 'drafts',
      extension: '/',
      label: 'drafts/',
      prefix: '',
    });
  });

  test('template content doc labels name-only, hiding the `.ok/templates/` prefix', () => {
    // Without a template branch the tab would read `docs/.ok/templates/note`;
    // it should read just the template name, like the skill branches.
    expect(tabParts('docs/.ok/templates/note', '.md')).toEqual({
      baseName: 'note',
      extension: '',
      label: 'note',
      prefix: '',
    });
    // Project-root template (no owning folder).
    expect(tabParts('.ok/templates/daily', '.md')).toEqual({
      baseName: 'daily',
      extension: '',
      label: 'daily',
      prefix: '',
    });
  });
});

describe('skill discriminators reject template content shapes', () => {
  // Templates are content docs sharing the `.ok/**` neighbourhood with skills;
  // the skill-only discriminators must not misclassify them, or a template tab
  // would inherit skill chrome / sidebar focus.
  const templateDocs = ['.ok/templates/daily', 'docs/.ok/templates/note', 'a/b/.ok/templates/x'];

  test('isSkillDocName is false for every template content doc', () => {
    for (const doc of templateDocs) expect(isSkillDocName(doc)).toBe(false);
  });

  test('isSkillBundleShapedPath is false for template content docs', () => {
    // The bundle-shaped regex is loose (no `^\.` anchor) but still requires a
    // `skills/<x>/…` segment, which a template path never has.
    for (const doc of templateDocs) expect(isSkillBundleShapedPath(doc)).toBe(false);
  });

  test('isSkillTabId is false for a template content doc tab', () => {
    expect(isSkillTabId(docTabId('docs/.ok/templates/note'))).toBe(false);
  });

  // Bundles are free to ship companion markdown beside SKILL.md — `tdd` on
  // skills.sh carries `tests.md` + `mocking.md` at its root. Those are ordinary
  // content docs, so the surface decision is the only thing keeping the sidebar
  // on Skills when the user clicks one straight after installing.
  const companionDocs = [
    '.claude/skills/tdd/mocking',
    '.claude/skills/tdd/tests',
    '.agents/skills/grill-me/GUIDE',
    'plugins/ok/skills/demo/notes/deep',
  ];

  test('isSkillBundleShapedPath is true for companion docs inside a bundle', () => {
    for (const doc of companionDocs) expect(isSkillBundleShapedPath(doc)).toBe(true);
  });

  test('isSkillTabId keeps a bundle companion doc on the Skills surface', () => {
    for (const doc of companionDocs) expect(isSkillTabId(docTabId(doc))).toBe(true);
  });

  test('isSkillBundleShapedPath is false for the bundle dir itself', () => {
    expect(isSkillBundleShapedPath('.claude/skills/tdd')).toBe(false);
  });
});
