import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({
    collabUrl: 'ws://localhost:1/collab',
    attempts: 0,
    terminal: false,
    lastError: null,
    retry: () => {},
  }),
}));

const { DocumentProvider, useDocumentContext } = await import('./DocumentContext');
const { folderTabId, docTabId, localTabSessionStorageKey } = await import('./editor-tabs');

/**
 * Drives the real `syncOpenTabsWithKnownTargets` on the real provider, so the
 * derivation that decides whether an exemption exists at all is under test, not
 * just the predicate it feeds. A literal `keepFolderPaths` would leave that
 * derivation free to return nothing and still look green.
 */
function Harness() {
  const ctx = useDocumentContext();
  return (
    <>
      <span data-testid="open-tabs">{ctx.openTabs.join('|')}</span>
      <button
        type="button"
        onClick={() =>
          ctx.openTarget(
            { kind: 'folder', target: 'notes', folderPath: 'notes' },
            { disposition: 'permanent', consumeActiveNewTab: false },
          )
        }
      >
        Open notes folder
      </button>
      <button
        type="button"
        onClick={() =>
          ctx.openTarget(
            { kind: 'folder', target: 'stale', folderPath: 'stale' },
            { disposition: 'permanent', consumeActiveNewTab: false },
          )
        }
      >
        Open stale folder
      </button>
      <button
        type="button"
        onClick={() =>
          ctx.openTarget(
            { kind: 'doc', target: 'readme', docName: 'readme' },
            { disposition: 'permanent', consumeActiveNewTab: false },
          )
        }
      >
        Open readme doc
      </button>
      <button
        type="button"
        onClick={() => {
          void ctx.reconcileLocalRename({
            renamed: [],
            renamedFolders: [{ fromPath: 'notes', toPath: 'renamed' }],
          });
        }}
      >
        Rename notes folder
      </button>
      <button
        type="button"
        onClick={() =>
          // The lag window: the folder exists on disk but the server listing has
          // not caught up, so `folderPaths` is empty.
          ctx.syncOpenTabsWithKnownTargets({
            pages: new Set<string>(),
            folderPaths: new Set<string>(),
            assetPaths: new Set<string>(),
            filePaths: new Set<string>(),
          })
        }
      >
        Sync empty listing
      </button>
    </>
  );
}

async function renderHarness() {
  render(
    <DocumentProvider>
      <Harness />
    </DocumentProvider>,
  );
  await act(async () => {});
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.location.hash = '';
});

describe('folder tab survives a stale page-list sync', () => {
  test.each([
    ['trailing-slash hash, the sidebar create and rename form', '#/notes/'],
    ['slashless hash, the wiki-link and Links panel form', '#/notes'],
  ])('%s', async (_label, hash) => {
    window.location.hash = hash;
    const user = userEvent.setup();
    await renderHarness();

    await user.click(screen.getByRole('button', { name: 'Open notes folder' }));
    expect(screen.getByTestId('open-tabs').textContent).toContain(folderTabId('notes'));

    await user.click(screen.getByRole('button', { name: 'Sync empty listing' }));
    await act(async () => {});

    expect(screen.getByTestId('open-tabs').textContent).toContain(folderTabId('notes'));
  });

  test('a restored session keeps its folder tab through a stale sync', async () => {
    // The session-restore path, distinct from the openTarget path above: the
    // tab comes back from storage rather than from a navigation. Kept because
    // the restore resolves the pane's target, which is what the exemption reads.
    window.localStorage.setItem(
      localTabSessionStorageKey(window.location.origin),
      JSON.stringify({
        updatedAt: new Date('2026-05-13T00:00:00.000Z').toISOString(),
        panes: [
          {
            id: 'pane-main',
            openTabs: [folderTabId('notes')],
            pinnedTabIds: [],
            activeTabId: folderTabId('notes'),
            size: 100,
          },
        ],
        focusedPaneId: 'pane-main',
      }),
    );
    window.location.hash = '#/notes/';
    const user = userEvent.setup();
    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId('open-tabs').textContent).toContain(folderTabId('notes'));
    await user.click(screen.getByRole('button', { name: 'Sync empty listing' }));
    await act(async () => {});
    expect(screen.getByTestId('open-tabs').textContent).toContain(folderTabId('notes'));
  });

  test('a renamed folder keeps its tab through a stale sync', async () => {
    // The traced scenario end to end: the sidebar creates a folder, the inline
    // rename commits, and a refresh lands before the server listing catches up.
    // `remapWorkspaceTabs` NULLS `activeTarget` when a tab id changes, so this
    // only holds because the commit re-derives it from `activeTabId` (see
    // `paneWithResolvedTarget`) before anything can observe the pane.
    window.location.hash = '#/notes/';
    const user = userEvent.setup();
    await renderHarness();

    await user.click(screen.getByRole('button', { name: 'Open notes folder' }));
    await user.click(screen.getByRole('button', { name: 'Rename notes folder' }));
    await act(async () => {});
    window.location.hash = '#/renamed/';
    expect(screen.getByTestId('open-tabs').textContent).toContain(folderTabId('renamed'));

    await user.click(screen.getByRole('button', { name: 'Sync empty listing' }));
    await act(async () => {});

    expect(screen.getByTestId('open-tabs').textContent).toContain(folderTabId('renamed'));
  });

  test('a folder the user is not on is still pruned', async () => {
    // Separates the exemption from a blanket folder carve-out. `stale` is open
    // but no pane displays it and the hash does not name it, so the prune must
    // still take it while the doc the hash points at survives.
    window.location.hash = '#/readme';
    const user = userEvent.setup();
    await renderHarness();

    await user.click(screen.getByRole('button', { name: 'Open stale folder' }));
    await user.click(screen.getByRole('button', { name: 'Open readme doc' }));
    expect(screen.getByTestId('open-tabs').textContent).toContain(folderTabId('stale'));

    await user.click(screen.getByRole('button', { name: 'Sync empty listing' }));
    await act(async () => {});

    const openTabs = screen.getByTestId('open-tabs').textContent ?? '';
    expect(openTabs).not.toContain(folderTabId('stale'));
    expect(openTabs).toContain(docTabId('readme'));
  });
});
