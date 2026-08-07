import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { hashFromAssetPath } from '@/lib/doc-hash';
import { emitLocalMenuAction } from '@/lib/local-menu-action-bus';
import { assetTabId, docTabId, localTabSessionStorageKey, skillFileTabId } from './editor-tabs';
import {
  requestPreviewTabPromotion,
  requestPreviewTabPromotionForTab,
} from './preview-tab-promotion';

let mockCollabUrl: string | null = null;

vi.doMock('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({
    collabUrl: mockCollabUrl,
    attempts: 0,
    terminal: false,
    lastError: null,
    retry: () => {},
  }),
}));

const { DocumentProvider, useDocumentContext } = await import('./DocumentContext');

const PINNED_TAB_ID = docTabId('Pinned.md');
const OTHER_TAB_ID = docTabId('Other.md');
const THIRD_TAB_ID = docTabId('Third.md');
const LICENSE_TAB_ID = assetTabId('LICENSE');
const SKILL_TAB_ID = skillFileTabId({ scope: 'project', name: 'example', path: 'SKILL.md' });
const originalFetch = globalThis.fetch;

function persistedTabSession(
  openTabs: string[],
  pinnedTabIds: string[],
  activeTabId: string | null,
  updatedAt: string | null,
) {
  return {
    activeTabByMode: { files: null, skills: null },
    updatedAt,
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

function seedTabSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify(
      persistedTabSession(
        [PINNED_TAB_ID, OTHER_TAB_ID],
        [PINNED_TAB_ID],
        PINNED_TAB_ID,
        new Date('2026-05-13T00:00:00.000Z').toISOString(),
      ),
    ),
  );
}

function seedActiveOtherTabSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify(
      persistedTabSession(
        [PINNED_TAB_ID, OTHER_TAB_ID],
        [],
        OTHER_TAB_ID,
        new Date('2026-05-13T00:00:00.000Z').toISOString(),
      ),
    ),
  );
}

function seedThreeTabSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify(
      persistedTabSession(
        [PINNED_TAB_ID, OTHER_TAB_ID, THIRD_TAB_ID],
        [],
        PINNED_TAB_ID,
        new Date('2026-05-13T00:00:00.000Z').toISOString(),
      ),
    ),
  );
}

function seedOnlyPinnedTabSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify(
      persistedTabSession(
        [PINNED_TAB_ID],
        [PINNED_TAB_ID],
        PINNED_TAB_ID,
        new Date('2026-05-13T00:00:00.000Z').toISOString(),
      ),
    ),
  );
}

function seedPaneWorkspaceSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify({
      activeTabByMode: { files: null, skills: null },
      panes: [
        {
          id: 'pane-left',
          openTabs: [PINNED_TAB_ID, OTHER_TAB_ID],
          pinnedTabIds: [PINNED_TAB_ID],
          activeTabId: PINNED_TAB_ID,
          size: 50,
        },
        {
          id: 'pane-right',
          openTabs: [THIRD_TAB_ID],
          pinnedTabIds: [],
          activeTabId: THIRD_TAB_ID,
          size: 50,
        },
      ],
      focusedPaneId: 'pane-right',
      updatedAt: new Date('2026-07-23T00:00:00.000Z').toISOString(),
    }),
  );
}

function seedSurfacePaneWorkspaceSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify({
      activeTabByMode: { files: PINNED_TAB_ID, skills: SKILL_TAB_ID },
      panes: [
        {
          id: 'pane-files',
          openTabs: [PINNED_TAB_ID],
          pinnedTabIds: [],
          activeTabId: PINNED_TAB_ID,
          size: 50,
        },
        {
          id: 'pane-skills',
          openTabs: [SKILL_TAB_ID],
          pinnedTabIds: [],
          activeTabId: SKILL_TAB_ID,
          size: 50,
        },
      ],
      focusedPaneId: 'pane-files',
      updatedAt: new Date('2026-08-04T00:00:00.000Z').toISOString(),
    }),
  );
}

function seedMixedSurfacePaneWorkspaceSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify({
      panes: [
        {
          id: 'pane-left',
          openTabs: [PINNED_TAB_ID],
          pinnedTabIds: [],
          activeTabId: PINNED_TAB_ID,
          size: 50,
        },
        {
          id: 'pane-right',
          openTabs: [OTHER_TAB_ID, SKILL_TAB_ID],
          pinnedTabIds: [],
          activeTabId: SKILL_TAB_ID,
          size: 50,
        },
      ],
      focusedPaneId: 'pane-left',
      updatedAt: new Date('2026-08-04T00:00:00.000Z').toISOString(),
    }),
  );
}

function seedReloadedFileOverSkillSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify({
      activeTabByMode: { files: OTHER_TAB_ID, skills: SKILL_TAB_ID },
      panes: [
        {
          id: 'pane-main',
          openTabs: [SKILL_TAB_ID, OTHER_TAB_ID],
          pinnedTabIds: [],
          activeTabId: OTHER_TAB_ID,
          size: 100,
        },
      ],
      focusedPaneId: 'pane-main',
      updatedAt: new Date('2026-08-04T00:00:00.000Z').toISOString(),
    }),
  );
}

function seedCloseFallbackPaneSession(leftPinned = false) {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify({
      panes: [
        {
          id: 'pane-left',
          openTabs: [OTHER_TAB_ID],
          pinnedTabIds: leftPinned ? [OTHER_TAB_ID] : [],
          activeTabId: OTHER_TAB_ID,
          size: 50,
        },
        {
          id: 'pane-right',
          openTabs: [PINNED_TAB_ID],
          pinnedTabIds: [PINNED_TAB_ID],
          activeTabId: PINNED_TAB_ID,
          size: 50,
        },
      ],
      focusedPaneId: 'pane-right',
      updatedAt: new Date('2026-08-04T00:00:00.000Z').toISOString(),
    }),
  );
}

type MenuActionLike = 'close-active-tab-or-window' | 'new-doc';

interface EditorBridgeStub {
  bridge: OkDesktopBridge;
  fire(action: MenuActionLike): void;
}

interface DeferredSessionBridgeStub {
  bridge: OkDesktopBridge;
  resolveSession(): void;
}

function makeEditorBridgeStub(
  sessionState = persistedTabSession([], [], null, null),
): EditorBridgeStub {
  const bridge = {
    config: {
      mode: 'editor',
      collabUrl: '',
      apiOrigin: '',
      projectPath: '',
      projectName: 'Test Project',
    },
    onMenuAction: () => () => {},
    project: {
      getSessionState: async () => sessionState,
      setSessionState: async () => undefined,
    },
  } as unknown as OkDesktopBridge;

  return {
    bridge,
    // The editor window's close-tab handler now listens on the renderer-local
    // menu-action bus (a real menu click reaches it via the bus forwarder), so
    // the test drives it with emitLocalMenuAction.
    fire: (action) => {
      act(() => emitLocalMenuAction(action));
    },
  };
}

function makeDeferredSessionBridgeStub(
  state: ReturnType<typeof persistedTabSession>,
): DeferredSessionBridgeStub {
  let resolveSession: (() => void) | null = null;
  const sessionLoaded = new Promise<typeof state>((resolve) => {
    resolveSession = () => resolve(state);
  });
  const bridge = {
    config: {
      mode: 'editor',
      collabUrl: '',
      apiOrigin: '',
      projectPath: '',
      projectName: 'Test Project',
    },
    onMenuAction: () => () => {},
    project: {
      getSessionState: async () => sessionLoaded,
      setSessionState: async () => undefined,
    },
  } as unknown as OkDesktopBridge;

  return {
    bridge,
    resolveSession: () => {
      resolveSession?.();
    },
  };
}

function Harness() {
  const ctx = useDocumentContext();
  return (
    <>
      <span data-testid="open-tabs">{ctx.openTabs.join('|')}</span>
      <span data-testid="pinned-tabs">{ctx.pinnedTabIds.join('|')}</span>
      <button type="button" onClick={() => ctx.closeTabs([PINNED_TAB_ID])}>
        Close pinned
      </button>
      <button type="button" onClick={() => ctx.closeTabs([PINNED_TAB_ID], { force: true })}>
        Force close pinned
      </button>
    </>
  );
}

function CloseActiveHarness() {
  const ctx = useDocumentContext();
  const [handled, setHandled] = useState<string>('');
  return (
    <>
      <span data-testid="open-tabs">{ctx.openTabs.join('|')}</span>
      <span data-testid="active-tab">{ctx.activeTabId ?? ''}</span>
      <span data-testid="new-tabs">{ctx.newTabIds.join('|')}</span>
      <span data-testid="active-new-tab">{ctx.activeNewTabId ?? ''}</span>
      <span data-testid="skill-focused">{String(ctx.skillFocused)}</span>
      <span data-testid="pane-state">
        {ctx.panes
          .map(
            (pane) =>
              `${pane.id}:${pane.openTabs.join(',')}:${pane.newTabIds.join(',')}:${pane.activeTabId ?? pane.activeNewTabId ?? ''}`,
          )
          .join('|')}
      </span>
      <span data-testid="close-handled">{handled}</span>
      <button type="button" onClick={() => ctx.openNewTab()}>
        Open new
      </button>
      <button type="button" onClick={() => ctx.setSkillsSidebar(false)}>
        Show files
      </button>
      <button type="button" onClick={() => ctx.setSkillsSidebar(true)}>
        Show skills
      </button>
      <button type="button" onClick={() => ctx.openNewTabInPane('pane-left')}>
        Open new in left
      </button>
      <button type="button" onClick={() => ctx.focusPane('pane-right')}>
        Focus right
      </button>
      <button type="button" onClick={() => ctx.openDocument('Other.md')}>
        Open other
      </button>
      <button
        type="button"
        onClick={() =>
          ctx.openTarget(
            { kind: 'doc', target: 'Other.md', docName: 'Other.md' },
            { disposition: 'permanent', consumeActiveNewTab: true },
          )
        }
      >
        Replace blank with other
      </button>
      <button type="button" onClick={() => ctx.closeTab(OTHER_TAB_ID)}>
        Close other
      </button>
      <button type="button" onClick={() => ctx.closeTab(THIRD_TAB_ID)}>
        Close third
      </button>
      <button type="button" onClick={() => setHandled(String(ctx.closeActiveTabOrWindow()))}>
        Close active
      </button>
      <button type="button" onClick={() => ctx.reopenClosedTab()}>
        Reopen closed
      </button>
      <button type="button" onClick={() => ctx.openTarget({ kind: 'skills', target: 'skills' })}>
        Resolve skills hub
      </button>
      <button
        type="button"
        onClick={() => {
          const first = ctx.newTabIds[0];
          if (first) ctx.activateNewTabInPane(ctx.focusedPaneId, first);
        }}
      >
        Activate first new tab
      </button>
    </>
  );
}

function BridgeCloseActiveHarness({ bridge }: { bridge: OkDesktopBridge }) {
  useLayoutEffect(() => {
    window.okDesktop = bridge;
    return () => {
      delete window.okDesktop;
    };
  }, [bridge]);
  return <CloseActiveHarness />;
}

function OpenLicenseDuringRestoreHarness() {
  const ctx = useDocumentContext();
  return (
    <>
      <span data-testid="open-tabs">{ctx.openTabs.join('|')}</span>
      <span data-testid="visible-tabs">{ctx.visibleTabIds.join('|')}</span>
      <span data-testid="active-tab">{ctx.activeTabId ?? ''}</span>
      <button
        type="button"
        onClick={() =>
          ctx.openTarget(
            {
              kind: 'asset',
              target: 'LICENSE',
              assetPath: 'LICENSE',
              mediaKind: null,
            },
            { disposition: 'permanent', consumeActiveNewTab: true },
          )
        }
      >
        Open license
      </button>
    </>
  );
}

function PaneWorkspaceHarness() {
  const ctx = useDocumentContext();
  return (
    <>
      <span data-testid="pane-count">{ctx.panes.length}</span>
      <span data-testid="stored-pane-count">{ctx.workspace.panes.length}</span>
      <span data-testid="focused-pane">{ctx.focusedPaneId}</span>
      <span data-testid="active-pane-tab">{ctx.activeTabId ?? ''}</span>
      <span data-testid="pane-tabs">
        {ctx.panes.map((pane) => `${pane.id}:${pane.openTabs.join(',')}`).join('|')}
      </span>
      <span data-testid="pane-visible-tabs">
        {ctx.panes
          .map((pane) => `${pane.id}:${(ctx.visibleTabIdsByPane.get(pane.id) ?? []).join(',')}`)
          .join('|')}
      </span>
      <span data-testid="session-loaded">{String(ctx.tabSessionLoaded)}</span>
      <button type="button" onClick={() => ctx.focusPane('pane-left')}>
        Focus left
      </button>
      <button type="button" onClick={() => ctx.focusPane('pane-right')}>
        Focus right
      </button>
      <button type="button" onClick={() => ctx.activateTabInPane('pane-files', PINNED_TAB_ID)}>
        Activate file surface
      </button>
      <button type="button" onClick={() => ctx.activateTabInPane('pane-skills', SKILL_TAB_ID)}>
        Activate skill surface
      </button>
      <button type="button" onClick={() => ctx.activateTabInPane('pane-left', OTHER_TAB_ID)}>
        Activate other in left
      </button>
      <button
        type="button"
        onClick={() =>
          ctx.openTarget(
            { kind: 'doc', target: 'Third.md', docName: 'Third.md' },
            { disposition: 'permanent', consumeActiveNewTab: true },
          )
        }
      >
        Open existing third
      </button>
      <button type="button" onClick={() => ctx.splitTab(OTHER_TAB_ID, 'pane-left', 'right')}>
        Split other
      </button>
      <button type="button" onClick={() => ctx.closeTabInPane('pane-left', OTHER_TAB_ID)}>
        Close other in left
      </button>
      <button type="button" onClick={() => ctx.openNewTabInPane('pane-left')}>
        Open blank in left
      </button>
      <button
        type="button"
        onClick={() => {
          const newTabId = ctx.panes.find((pane) => pane.id === 'pane-left')?.newTabIds[0];
          if (!newTabId) return;
          ctx.reorderTabsInPane('pane-left', [PINNED_TAB_ID, newTabId, OTHER_TAB_ID], newTabId);
        }}
      >
        Interleave blank in left
      </button>
      <button type="button" onClick={() => ctx.moveTabToPane(THIRD_TAB_ID, 'pane-left', 2)}>
        Move third into visible slot
      </button>
      <button type="button" onClick={() => ctx.reopenClosedTab()}>
        Reopen pane tab
      </button>
    </>
  );
}

function ProviderHarness({ children }: { children: ReactNode }) {
  return <DocumentProvider>{children}</DocumentProvider>;
}

function PreviewEditHarness() {
  const ctx = useDocumentContext();
  const openPreview = (docName: string) =>
    ctx.openTarget(
      { kind: 'doc', target: docName, docName },
      { disposition: 'preview', consumeActiveNewTab: false },
    );
  return (
    <>
      <span data-testid="open-tabs">{ctx.openTabs.join('|')}</span>
      <span data-testid="preview-tab">
        {[...ctx.previewTabIdsByPane.values()].map((tabId) => tabId ?? '').join('|')}
      </span>
      <span data-testid="session-loaded">{String(ctx.tabSessionLoaded)}</span>
      <button type="button" onClick={() => openPreview('First.md')}>
        Preview first
      </button>
      <button type="button" onClick={() => openPreview('Second.md')}>
        Preview second
      </button>
      <button
        type="button"
        onClick={() =>
          ctx.openTarget(
            { kind: 'asset', target: 'LICENSE', assetPath: 'LICENSE', mediaKind: null },
            { disposition: 'preview', consumeActiveNewTab: false },
          )
        }
      >
        Preview asset
      </button>
    </>
  );
}

describe('DocumentContext preview-tab promotion on user edit', () => {
  afterEach(() => {
    cleanup();
    mockCollabUrl = null;
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    window.location.hash = '';
  });

  /** Opens bail during the restore window, so settle it before driving tabs. */
  async function renderSettled() {
    // Restore is gated on a resolved collab URL; without one `tabSessionLoaded`
    // never flips and every open stays in the restore window.
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;
    window.localStorage.setItem(
      localTabSessionStorageKey(window.location.origin),
      JSON.stringify(
        persistedTabSession([], [], null, new Date('2026-05-13T00:00:00.000Z').toISOString()),
      ),
    );
    render(<PreviewEditHarness />, { wrapper: ProviderHarness });
    await waitFor(() => {
      expect(screen.getByTestId('session-loaded').textContent).toBe('true');
    });
    return userEvent.setup();
  }

  test('an edit promotes the preview tab, so the next sidebar click opens beside it', async () => {
    const user = await renderSettled();

    await user.click(screen.getByRole('button', { name: 'Preview first' }));
    expect(screen.getByTestId('preview-tab').textContent).toBe(docTabId('First.md'));

    // The notification the editors emit on a user-intent content change.
    act(() => {
      requestPreviewTabPromotion('First.md');
    });
    expect(screen.getByTestId('preview-tab').textContent).toBe('');

    await user.click(screen.getByRole('button', { name: 'Preview second' }));
    expect(screen.getByTestId('open-tabs').textContent).toBe(
      `${docTabId('First.md')}|${docTabId('Second.md')}`,
    );
  });

  test('without an edit the preview tab is still replaced', async () => {
    // The control. Preview replacement is correct behavior, not collateral of
    // the bug — this pins that the fix did not turn every click permanent.
    const user = await renderSettled();

    await user.click(screen.getByRole('button', { name: 'Preview first' }));
    await user.click(screen.getByRole('button', { name: 'Preview second' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(docTabId('Second.md'));
  });

  test('an edit to a document with no open tab changes nothing', async () => {
    const user = await renderSettled();

    await user.click(screen.getByRole('button', { name: 'Preview first' }));
    act(() => {
      requestPreviewTabPromotion('Unopened.md');
    });

    expect(screen.getByTestId('preview-tab').textContent).toBe(docTabId('First.md'));
    expect(screen.getByTestId('open-tabs').textContent).toBe(docTabId('First.md'));
  });

  test('the listener is torn down with the provider', () => {
    const { unmount } = render(<PreviewEditHarness />, { wrapper: ProviderHarness });
    unmount();
    // A notification arriving after teardown must not reach a disposed context.
    expect(() => requestPreviewTabPromotion('First.md')).not.toThrow();
  });

  test('a non-document preview tab promotes too, via its tab id', async () => {
    // The sidebar can preview an asset, whose tab id is NOT its document name.
    // Promotion is keyed by tab id precisely so this tab is reachable; the
    // earlier docName-only API could not address it at all.
    const user = await renderSettled();

    await user.click(screen.getByRole('button', { name: 'Preview asset' }));
    expect(screen.getByTestId('preview-tab').textContent).toBe(LICENSE_TAB_ID);

    act(() => {
      requestPreviewTabPromotionForTab(LICENSE_TAB_ID);
    });
    expect(screen.getByTestId('preview-tab').textContent).toBe('');

    await user.click(screen.getByRole('button', { name: 'Preview first' }));
    expect(screen.getByTestId('open-tabs').textContent).toBe(
      `${LICENSE_TAB_ID}|${docTabId('First.md')}`,
    );
  });
});

describe('DocumentContext tab close force contract', () => {
  afterEach(() => {
    cleanup();
    delete window.okDesktop;
    mockCollabUrl = null;
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    window.location.hash = '';
  });

  test('closeTabs skips pinned tabs unless force is explicitly set', async () => {
    seedTabSession();
    render(<Harness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('open-tabs').textContent).toBe(`${PINNED_TAB_ID}|${OTHER_TAB_ID}`);
    expect(screen.getByTestId('pinned-tabs').textContent).toBe(PINNED_TAB_ID);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close pinned' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(`${PINNED_TAB_ID}|${OTHER_TAB_ID}`);
    expect(screen.getByTestId('pinned-tabs').textContent).toBe(PINNED_TAB_ID);

    await user.click(screen.getByRole('button', { name: 'Force close pinned' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(OTHER_TAB_ID);
    expect(screen.getByTestId('pinned-tabs').textContent).toBe('');
  });

  test('closeActiveTabOrWindow closes one active tab and reports the menu action handled', async () => {
    seedActiveOtherTabSession();
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('open-tabs').textContent).toBe(`${PINNED_TAB_ID}|${OTHER_TAB_ID}`);
    expect(screen.getByTestId('active-tab').textContent).toBe(OTHER_TAB_ID);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('close-handled').textContent).toBe('true');
    expect(screen.getByTestId('open-tabs').textContent).toBe(PINNED_TAB_ID);
    expect(screen.getByTestId('active-tab').textContent).toBe(PINNED_TAB_ID);
  });

  test('reopenClosedTab restores the most recently closed tab and activates it', async () => {
    seedActiveOtherTabSession();
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(PINNED_TAB_ID);
    expect(screen.getByTestId('active-tab').textContent).toBe(PINNED_TAB_ID);

    await user.click(screen.getByRole('button', { name: 'Reopen closed' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(`${PINNED_TAB_ID}|${OTHER_TAB_ID}`);
    expect(screen.getByTestId('active-tab').textContent).toBe(OTHER_TAB_ID);
  });

  test('reopenClosedTab skips already-open entries and continues to the next closed tab', async () => {
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;
    seedThreeTabSession();
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close third' }));
    await user.click(screen.getByRole('button', { name: 'Close other' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(PINNED_TAB_ID);

    await user.click(screen.getByRole('button', { name: 'Open other' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(`${PINNED_TAB_ID}|${OTHER_TAB_ID}`);
    expect(screen.getByTestId('active-tab').textContent).toBe(OTHER_TAB_ID);

    await user.click(screen.getByRole('button', { name: 'Reopen closed' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(
      `${PINNED_TAB_ID}|${OTHER_TAB_ID}|${THIRD_TAB_ID}`,
    );
    expect(screen.getByTestId('active-tab').textContent).toBe(THIRD_TAB_ID);
  });

  test('reopenClosedTab ignores closed new-tab placeholders', async () => {
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open new' }));
    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('new-tabs').textContent).toBe('');
    expect(screen.getByTestId('active-new-tab').textContent).toBe('');

    await user.click(screen.getByRole('button', { name: 'Reopen closed' }));

    expect(screen.getByTestId('new-tabs').textContent).toBe('');
    expect(screen.getByTestId('active-new-tab').textContent).toBe('');
  });

  test('permanent navigation consumes a blank tab when the target is already open', async () => {
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;
    seedActiveOtherTabSession();
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open new' }));
    expect(screen.getByTestId('active-new-tab').textContent).toBe('new-tab:1');

    await user.click(screen.getByRole('button', { name: 'Replace blank with other' }));

    expect(screen.getByTestId('new-tabs').textContent).toBe('');
    expect(screen.getByTestId('active-new-tab').textContent).toBe('');
    expect(screen.getByTestId('active-tab').textContent).toBe(OTHER_TAB_ID);
  });

  test('closeActiveTabOrWindow skips active pinned tab and closes the next visible unpinned tab', async () => {
    seedTabSession();
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('open-tabs').textContent).toBe(`${PINNED_TAB_ID}|${OTHER_TAB_ID}`);
    expect(screen.getByTestId('active-tab').textContent).toBe(PINNED_TAB_ID);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('close-handled').textContent).toBe('true');
    expect(screen.getByTestId('open-tabs').textContent).toBe(PINNED_TAB_ID);
    expect(screen.getByTestId('active-tab').textContent).toBe(PINNED_TAB_ID);
  });

  test('closeActiveTabOrWindow reports unhandled when only pinned tabs remain', async () => {
    seedOnlyPinnedTabSession();
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('close-handled').textContent).toBe('false');
    expect(screen.getByTestId('open-tabs').textContent).toBe(PINNED_TAB_ID);
    expect(screen.getByTestId('active-tab').textContent).toBe(PINNED_TAB_ID);
  });

  test('closeActiveTabOrWindow closes an active new tab before falling back to the window', async () => {
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open new' }));

    expect(screen.getByTestId('new-tabs').textContent).toBe('new-tab:1');
    expect(screen.getByTestId('active-new-tab').textContent).toBe('new-tab:1');

    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('close-handled').textContent).toBe('true');
    expect(screen.getByTestId('new-tabs').textContent).toBe('');
    expect(screen.getByTestId('active-new-tab').textContent).toBe('');
  });

  test('closes the last Files new tab even when a hidden skill tab remains', async () => {
    window.localStorage.setItem(
      localTabSessionStorageKey(window.location.origin),
      JSON.stringify(
        persistedTabSession(
          [SKILL_TAB_ID],
          [],
          SKILL_TAB_ID,
          new Date('2026-08-04T00:00:00.000Z').toISOString(),
        ),
      ),
    );
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show files' }));
    expect(screen.getByTestId('skill-focused').textContent).toBe('false');
    expect(screen.getByTestId('active-new-tab').textContent).toMatch(/^new-tab:\d+$/);

    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('new-tabs').textContent).toBe('');
    expect(screen.getByTestId('active-new-tab').textContent).toBe('');
    expect(screen.getByTestId('active-tab').textContent).toBe('');
    expect(screen.getByTestId('skill-focused').textContent).toBe('false');
    expect(screen.getByTestId('open-tabs').textContent).toBe(SKILL_TAB_ID);

    await user.click(screen.getByRole('button', { name: 'Show skills' }));

    expect(screen.getByTestId('skill-focused').textContent).toBe('true');
    expect(screen.getByTestId('active-tab').textContent).toBe(SKILL_TAB_ID);
  });

  test('closeActiveTabOrWindow reports unhandled when no visible tabs remain', async () => {
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('close-handled').textContent).toBe('false');
    expect(screen.getByTestId('open-tabs').textContent).toBe('');
    expect(screen.getByTestId('active-tab').textContent).toBe('');
  });

  test('closeActiveTabOrWindow falls back to an unpinned tab in another pane', async () => {
    seedCloseFallbackPaneSession();
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('close-handled').textContent).toBe('true');
    expect(screen.getByTestId('pane-state').textContent).toBe(
      `pane-right:${PINNED_TAB_ID}::${PINNED_TAB_ID}`,
    );
  });

  test('closeActiveTabOrWindow reports unhandled when every pane contains only pinned tabs', async () => {
    seedCloseFallbackPaneSession(true);
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('close-handled').textContent).toBe('false');
    expect(screen.getByTestId('pane-state').textContent).toContain(
      `pane-left:${OTHER_TAB_ID}::${OTHER_TAB_ID}`,
    );
    expect(screen.getByTestId('pane-state').textContent).toContain(
      `pane-right:${PINNED_TAB_ID}::${PINNED_TAB_ID}`,
    );
  });

  test('closeActiveTabOrWindow prefers a blank tab when falling back to another pane', async () => {
    seedCloseFallbackPaneSession();
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open new in left' }));
    await user.click(screen.getByRole('button', { name: 'Focus right' }));
    await user.click(screen.getByRole('button', { name: 'Close active' }));

    expect(screen.getByTestId('close-handled').textContent).toBe('true');
    expect(screen.getByTestId('pane-state').textContent).toContain(
      `pane-left:${OTHER_TAB_ID}::${OTHER_TAB_ID}`,
    );
    expect(screen.getByTestId('pane-state').textContent).not.toContain('new-tab:1');
  });

  test('desktop close-active-tab-or-window action closes tabs before closing the editor window', async () => {
    seedActiveOtherTabSession();
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    const stub = makeEditorBridgeStub(
      persistedTabSession(
        [PINNED_TAB_ID, OTHER_TAB_ID],
        [],
        OTHER_TAB_ID,
        new Date('2026-05-13T00:00:00.000Z').toISOString(),
      ),
    );

    render(<BridgeCloseActiveHarness bridge={stub.bridge} />, { wrapper: ProviderHarness });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByTestId('open-tabs').textContent).toBe(`${PINNED_TAB_ID}|${OTHER_TAB_ID}`);

    stub.fire('close-active-tab-or-window');

    expect(closeSpy).toHaveBeenCalledTimes(0);
    expect(screen.getByTestId('open-tabs').textContent).toBe(PINNED_TAB_ID);

    cleanup();
    delete window.okDesktop;
    window.localStorage.clear();

    const emptyStub = makeEditorBridgeStub();
    render(<BridgeCloseActiveHarness bridge={emptyStub.bridge} />, { wrapper: ProviderHarness });
    await new Promise((r) => setTimeout(r, 0));

    emptyStub.fire('close-active-tab-or-window');

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('open-tabs').textContent).toBe('');
    closeSpy.mockRestore();
  });
});

const REORDER_A = docTabId('A.md');
const REORDER_B = docTabId('B.md');
const REORDER_C = docTabId('C.md');

function seedReorderSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify(
      persistedTabSession(
        [REORDER_A, REORDER_B, REORDER_C],
        [REORDER_A],
        REORDER_A,
        new Date('2026-05-16T00:00:00.000Z').toISOString(),
      ),
    ),
  );
}

function ReorderHarness({
  newOrder,
  draggedTabId,
}: {
  newOrder: readonly string[];
  draggedTabId: string;
}) {
  const ctx = useDocumentContext();
  return (
    <>
      <span data-testid="open-tabs">{ctx.openTabs.join('|')}</span>
      <span data-testid="pinned-tabs">{ctx.pinnedTabIds.join('|')}</span>
      <span data-testid="visible-tabs">{ctx.visibleTabIds.join('|')}</span>
      <button type="button" onClick={() => ctx.reorderTabs(newOrder, draggedTabId)}>
        Reorder
      </button>
    </>
  );
}

describe('DocumentContext reorderTabs — order + drag-mutable pin', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.location.hash = '';
  });

  test('dragging the lone pinned tab out of the pinned zone unpins it (wired end-to-end)', async () => {
    // Seed: [A,B,C] pinned {A}. Zone = index 0 only. Drag A → index 1.
    // reorderTabs must thread the dragged id through applyDragPinMutation so
    // the context's pinnedTabIds drops A.
    seedReorderSession();
    render(
      <ReorderHarness newOrder={[REORDER_B, REORDER_A, REORDER_C]} draggedTabId={REORDER_A} />,
      {
        wrapper: ProviderHarness,
      },
    );

    expect(screen.getByTestId('pinned-tabs').textContent).toBe(REORDER_A);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reorder' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(
      `${REORDER_B}|${REORDER_A}|${REORDER_C}`,
    );
    expect(screen.getByTestId('visible-tabs').textContent).toBe(
      `${REORDER_B}|${REORDER_A}|${REORDER_C}`,
    );
    // A left the size-1 pinned zone → unpinned.
    expect(screen.getByTestId('pinned-tabs').textContent).toBe('');
  });

  test('dragging an unpinned tab into the pinned zone pins it; non-dragged tabs keep state', async () => {
    // Seed: [A,B,C] pinned {A}. Drag C to index 0 (into the size-1 zone).
    // C pins; A is not the dragged tab so it stays pinned.
    seedReorderSession();
    render(
      <ReorderHarness newOrder={[REORDER_C, REORDER_A, REORDER_B]} draggedTabId={REORDER_C} />,
      {
        wrapper: ProviderHarness,
      },
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reorder' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(
      `${REORDER_C}|${REORDER_A}|${REORDER_B}`,
    );
    expect(screen.getByTestId('pinned-tabs').textContent).toBe(`${REORDER_C}|${REORDER_A}`);
  });

  test('reorderTabs is a no-op when the supplied order matches the current order', async () => {
    seedReorderSession();
    render(
      <ReorderHarness newOrder={[REORDER_A, REORDER_B, REORDER_C]} draggedTabId={REORDER_A} />,
      {
        wrapper: ProviderHarness,
      },
    );

    const beforeOpen = screen.getByTestId('open-tabs').textContent;
    const beforePinned = screen.getByTestId('pinned-tabs').textContent;
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reorder' }));
    // Unchanged order short-circuits before pin mutation — pin set untouched.
    expect(screen.getByTestId('open-tabs').textContent).toBe(beforeOpen);
    expect(screen.getByTestId('pinned-tabs').textContent).toBe(beforePinned);
  });

  test('reorderTabs commits a new-tab-placeholder reorder among doc-tabs (QA-024)', async () => {
    // Seed: openTabs=[A,B,C], pinned=[A]; harness creates a new-tab and reorders
    // it BETWEEN A and B. Per-bucket orders are unchanged ([A,B,C] and [t1]),
    // but the visible interleave moves t1 from end → middle. The reorder must
    // commit the new visible order even though both buckets compare equal.
    seedReorderSession();
    function NewTabReorderHarness() {
      const ctx = useDocumentContext();
      return (
        <>
          <span data-testid="visible-tabs">{ctx.visibleTabIds.join('|')}</span>
          <button
            type="button"
            onClick={() => {
              ctx.openNewTab();
            }}
          >
            New tab
          </button>
          <button
            type="button"
            onClick={() => {
              const visible = ctx.visibleTabIds;
              const newTabId = ctx.newTabIds[0];
              if (!newTabId) return;
              // Move new-tab from index 3 (end) to index 1 (between A and B).
              const next = visible.filter((id) => id !== newTabId);
              next.splice(1, 0, newTabId);
              ctx.reorderTabs(next, newTabId);
            }}
          >
            Move new-tab to middle
          </button>
        </>
      );
    }
    render(<NewTabReorderHarness />, { wrapper: ProviderHarness });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New tab' }));
    const beforeReorder = screen.getByTestId('visible-tabs').textContent ?? '';
    const beforeParts = beforeReorder.split('|');
    expect(beforeParts).toEqual([REORDER_A, REORDER_B, REORDER_C, beforeParts[3] ?? '']);
    const newTabId = beforeParts[3];
    expect(newTabId).toMatch(/^new-tab:/);
    await user.click(screen.getByRole('button', { name: 'Move new-tab to middle' }));
    const afterParts = (screen.getByTestId('visible-tabs').textContent ?? '').split('|');
    expect(afterParts).toEqual([REORDER_A, newTabId, REORDER_B, REORDER_C]);
  });

  test('reorderTabs defensively appends any open tab the caller forgot to include', async () => {
    seedReorderSession();
    // Caller passes only [C, A] — B was forgotten; reorderTabs must append B
    // rather than silently drop it from openTabs. Dragged = B (the appended
    // tab lands at index 2, outside the size-1 zone, and was already
    // unpinned) so pin state is unperturbed and the test stays focused on the
    // append backstop.
    render(<ReorderHarness newOrder={[REORDER_C, REORDER_A]} draggedTabId={REORDER_B} />, {
      wrapper: ProviderHarness,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reorder' }));
    const tabs = screen.getByTestId('open-tabs').textContent ?? '';
    expect(tabs.split('|')).toEqual([REORDER_C, REORDER_A, REORDER_B]);
    // A was not dragged → still pinned; the defensive append did not touch pin.
    expect(screen.getByTestId('pinned-tabs').textContent).toBe(REORDER_A);
  });
});

const COLD_START_DOC = docTabId('event_watcher');
const SAME_STEM_MD_TAB = docTabId('foo.md');
const SAME_STEM_MDX_TAB = docTabId('foo.mdx');

function seedColdStartSession() {
  // The state a cold single-file window reaches mid-startup: the seeded doc tab
  // is already open + active while the page list is still loading.
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify(
      persistedTabSession(
        [COLD_START_DOC],
        [],
        COLD_START_DOC,
        new Date('2026-06-07T00:00:00.000Z').toISOString(),
      ),
    ),
  );
}

function seedSameStemActiveMdxSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify(
      persistedTabSession(
        [SAME_STEM_MD_TAB, SAME_STEM_MDX_TAB],
        [],
        SAME_STEM_MDX_TAB,
        new Date('2026-06-07T00:00:00.000Z').toISOString(),
      ),
    ),
  );
}

function ColdStartSyncHarness() {
  const ctx = useDocumentContext();
  return (
    <>
      <span data-testid="open-tabs">{ctx.openTabs.join('|')}</span>
      <button
        type="button"
        // The first sync of a cold start fires while the page list is still
        // empty (it arrives empty-then-populated).
        onClick={() =>
          ctx.syncOpenTabsWithKnownTargets({
            pages: new Set(),
            folderPaths: new Set(),
            assetPaths: new Set(),
          })
        }
      >
        Sync empty pages
      </button>
    </>
  );
}

function SameStemSyncHarness() {
  const ctx = useDocumentContext();
  return (
    <>
      <span data-testid="open-tabs">{ctx.openTabs.join('|')}</span>
      <span data-testid="active-tab">{ctx.activeTabId ?? ''}</span>
      <button
        type="button"
        onClick={() =>
          ctx.syncOpenTabsWithKnownTargets({
            pages: new Set(['foo']),
            folderPaths: new Set(),
            assetPaths: new Set(),
          })
        }
      >
        Sync canonical page
      </button>
    </>
  );
}

describe('DocumentContext syncOpenTabsWithKnownTargets — cold-start hash preservation', () => {
  afterEach(() => {
    cleanup();
    mockCollabUrl = null;
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    window.location.hash = '';
  });

  test('a sync against transiently-empty pages keeps the hash-targeted doc (no empty-state splash)', async () => {
    // Regression: `ok <file>` cold launch. The window seeds `#/event_watcher`,
    // the doc tab is open, but the page list arrives empty-then-populated. A
    // sync firing in that empty window must NOT prune the doc and clear the hash
    // — `activeTarget` is still `doc` (not yet `missing`), so `keepMissingDocName`
    // is null here and only `keepHashDocName` saves it. Without the rescue the
    // hash clears to '' and the editor falls through to the "Create something
    // great" splash ~50% of cold opens.
    seedColdStartSession();
    window.location.hash = '#/event_watcher';
    render(<ColdStartSyncHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('open-tabs').textContent).toBe(COLD_START_DOC);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sync empty pages' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(COLD_START_DOC);
    expect(window.location.hash).toBe('#/event_watcher');
  });

  test('same-stem md and mdx tabs survive canonical extensionless page sync', async () => {
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;
    seedSameStemActiveMdxSession();
    window.location.hash = '#/foo.mdx';
    render(<SameStemSyncHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('open-tabs').textContent).toBe(
      `${SAME_STEM_MD_TAB}|${SAME_STEM_MDX_TAB}`,
    );
    await waitFor(() => {
      expect(screen.getByTestId('active-tab').textContent).toBe(SAME_STEM_MDX_TAB);
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sync canonical page' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(
      `${SAME_STEM_MD_TAB}|${SAME_STEM_MDX_TAB}`,
    );
    expect(screen.getByTestId('active-tab').textContent).toBe(SAME_STEM_MDX_TAB);
    expect(window.location.hash).toBe('#/foo.mdx');
  });
});

describe('DocumentContext tab restore', () => {
  afterEach(() => {
    cleanup();
    delete window.okDesktop;
    mockCollabUrl = null;
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    window.location.hash = '';
  });

  test('restores the desktop session before collaboration identity resolves', async () => {
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as never;
    const stub = makeDeferredSessionBridgeStub(
      persistedTabSession(
        [OTHER_TAB_ID],
        [],
        OTHER_TAB_ID,
        new Date('2026-07-28T00:00:00.000Z').toISOString(),
      ),
    );
    window.okDesktop = stub.bridge;

    render(<PaneWorkspaceHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('session-loaded').textContent).toBe('false');
    act(() => {
      stub.resolveSession();
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-loaded').textContent).toBe('true');
      expect(screen.getByTestId('active-pane-tab').textContent).toBe(OTHER_TAB_ID);
    });
  });

  test('restores an extension-qualified mdx tab over an ambiguous extensionless hash', async () => {
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;
    seedSameStemActiveMdxSession();
    window.location.hash = '#/foo';

    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    await waitFor(() => {
      expect(screen.getByTestId('active-tab').textContent).toBe(SAME_STEM_MDX_TAB);
    });
    expect(window.location.hash).toBe('#/foo.mdx');
  });

  test('keeps saved tab order when an active asset hash opens before session restore resolves', async () => {
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;
    const stub = makeDeferredSessionBridgeStub(
      persistedTabSession(
        [OTHER_TAB_ID, LICENSE_TAB_ID],
        [],
        LICENSE_TAB_ID,
        new Date('2026-06-07T00:00:00.000Z').toISOString(),
      ),
    );
    window.okDesktop = stub.bridge;
    window.location.hash = hashFromAssetPath('LICENSE');

    render(<OpenLicenseDuringRestoreHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open license' }));

    expect(screen.getByTestId('visible-tabs').textContent).toBe(LICENSE_TAB_ID);

    act(() => {
      stub.resolveSession();
    });

    await waitFor(() => {
      expect(screen.getByTestId('open-tabs').textContent).toBe(`${OTHER_TAB_ID}|${LICENSE_TAB_ID}`);
      expect(screen.getByTestId('visible-tabs').textContent).toBe(
        `${OTHER_TAB_ID}|${LICENSE_TAB_ID}`,
      );
      expect(screen.getByTestId('active-tab').textContent).toBe(LICENSE_TAB_ID);
    });
    expect(window.location.hash).toBe(hashFromAssetPath('LICENSE'));
  });

  test('keeps a new tab active when session restore resolves afterward', async () => {
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;
    const stub = makeDeferredSessionBridgeStub(
      persistedTabSession(
        [OTHER_TAB_ID],
        [],
        OTHER_TAB_ID,
        new Date('2026-06-07T00:00:00.000Z').toISOString(),
      ),
    );
    window.okDesktop = stub.bridge;
    window.location.hash = '#/Other.md';

    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open new' }));
    expect(screen.getByTestId('active-new-tab').textContent).toBe('new-tab:1');

    act(() => {
      stub.resolveSession();
    });

    await waitFor(() => {
      expect(screen.getByTestId('active-new-tab').textContent).toBe('new-tab:1');
      expect(screen.getByTestId('active-tab').textContent).toBe('');
    });
  });
});

describe('DocumentContext pane workspace', () => {
  afterEach(() => {
    cleanup();
    delete window.okDesktop;
    mockCollabUrl = null;
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    window.location.hash = '';
  });

  test('restores pane membership and projects the focused pane through compatibility globals', async () => {
    seedPaneWorkspaceSession();
    render(<PaneWorkspaceHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('pane-count').textContent).toBe('2');
    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-right');
    expect(screen.getByTestId('active-pane-tab').textContent).toBe(THIRD_TAB_ID);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Activate other in left' }));

    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-left');
    expect(screen.getByTestId('active-pane-tab').textContent).toBe(OTHER_TAB_ID);
    expect(window.location.hash).toBe('#/Other.md');
  });

  test('activates the first tab when a reloaded pane has no valid active tab', () => {
    seedPaneWorkspaceSession();
    const storageKey = localTabSessionStorageKey(window.location.origin);
    const session = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}');
    session.panes[1].activeTabId = 'missing';
    window.localStorage.setItem(storageKey, JSON.stringify(session));
    window.location.hash = '#/not-open';

    render(<PaneWorkspaceHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-right');
    expect(screen.getByTestId('active-pane-tab').textContent).toBe(THIRD_TAB_ID);
  });

  test('removes panes with no tabs on the active surface without deleting their workspace state', async () => {
    seedSurfacePaneWorkspaceSession();
    render(<PaneWorkspaceHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('pane-count').textContent).toBe('1');
    expect(screen.getByTestId('stored-pane-count').textContent).toBe('2');
    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-files');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Activate skill surface' }));

    expect(screen.getByTestId('pane-count').textContent).toBe('1');
    expect(screen.getByTestId('stored-pane-count').textContent).toBe('2');
    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-skills');

    await user.click(screen.getByRole('button', { name: 'Activate file surface' }));

    expect(screen.getByTestId('pane-count').textContent).toBe('1');
    expect(screen.getByTestId('stored-pane-count').textContent).toBe('2');
    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-files');
  });

  test('focuses a pane through its active-surface tab instead of revealing a hidden tab', async () => {
    seedMixedSurfacePaneWorkspaceSession();
    render(<PaneWorkspaceHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('pane-count').textContent).toBe('2');
    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-left');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Focus right' }));

    expect(screen.getByTestId('pane-count').textContent).toBe('2');
    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-right');
    expect(screen.getByTestId('active-pane-tab').textContent).toBe(OTHER_TAB_ID);
  });

  test('does not reveal a restored skill tab when the active file tab closes', async () => {
    seedReloadedFileOverSkillSession();
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });

    expect(screen.getByTestId('active-tab').textContent).toBe(OTHER_TAB_ID);
    expect(screen.getByTestId('skill-focused').textContent).toBe('false');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close other' }));

    expect(screen.getByTestId('skill-focused').textContent).toBe('false');
    expect(screen.getByTestId('active-tab').textContent).toBe('');
    expect(screen.getByTestId('active-new-tab').textContent).toMatch(/^new-tab:\d+$/);
    expect(screen.getByTestId('open-tabs').textContent).toBe(SKILL_TAB_ID);
  });

  test('focuses the owning pane instead of duplicating an already-open target', async () => {
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;
    seedPaneWorkspaceSession();
    render(<PaneWorkspaceHarness />, { wrapper: ProviderHarness });

    await waitFor(() => {
      expect(screen.getByTestId('session-loaded').textContent).toBe('true');
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Focus left' }));
    await user.click(screen.getByRole('button', { name: 'Open existing third' }));

    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-right');
    expect(screen.getByTestId('active-pane-tab').textContent).toBe(THIRD_TAB_ID);
    expect(screen.getByTestId('pane-tabs').textContent?.match(/Third\.md/g)).toHaveLength(1);
  });

  test('splits a tab into a focused pane without duplicating its target', async () => {
    seedPaneWorkspaceSession();
    render(<PaneWorkspaceHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Split other' }));

    expect(screen.getByTestId('pane-count').textContent).toBe('3');
    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-1');
    expect(screen.getByTestId('active-pane-tab').textContent).toBe(OTHER_TAB_ID);
    expect(screen.getByTestId('pane-tabs').textContent?.match(/Other\.md/g)).toHaveLength(1);
  });

  test('maps a cross-pane visible drop slot around a blank tab to regular-tab order', async () => {
    seedPaneWorkspaceSession();
    render(<PaneWorkspaceHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open blank in left' }));
    await user.click(screen.getByRole('button', { name: 'Interleave blank in left' }));
    await user.click(screen.getByRole('button', { name: 'Move third into visible slot' }));

    expect(screen.getByTestId('pane-tabs').textContent).toBe(
      `pane-left:${PINNED_TAB_ID},${THIRD_TAB_ID},${OTHER_TAB_ID}`,
    );
    expect(screen.getByTestId('pane-visible-tabs').textContent).toBe(
      `pane-left:${PINNED_TAB_ID},new-tab:1,${THIRD_TAB_ID},${OTHER_TAB_ID}`,
    );
  });

  test('reopens a background pane tab in its surviving owner pane', async () => {
    seedPaneWorkspaceSession();
    render(<PaneWorkspaceHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close other in left' }));
    expect(screen.getByTestId('pane-tabs').textContent).not.toContain(OTHER_TAB_ID);

    await user.click(screen.getByRole('button', { name: 'Reopen pane tab' }));

    expect(screen.getByTestId('focused-pane').textContent).toBe('pane-left');
    expect(screen.getByTestId('active-pane-tab').textContent).toBe(OTHER_TAB_ID);
    expect(screen.getByTestId('pane-tabs').textContent).toContain(
      `pane-left:${PINNED_TAB_ID},${OTHER_TAB_ID}`,
    );
  });
});

const RENAME_FOO = docTabId('foo.md');
const RENAME_BAR = docTabId('bar.md');
const RENAME_BAZZ = docTabId('bazz.md');

function seedRenameSession() {
  window.localStorage.setItem(
    localTabSessionStorageKey(window.location.origin),
    JSON.stringify(
      persistedTabSession(
        [RENAME_FOO, RENAME_BAR],
        [],
        RENAME_FOO,
        new Date('2026-05-16T00:00:00.000Z').toISOString(),
      ),
    ),
  );
}

function RenameHarness({ fromDocName, toDocName }: { fromDocName: string; toDocName: string }) {
  const ctx = useDocumentContext();
  return (
    <>
      <span data-testid="open-tabs">{ctx.openTabs.join('|')}</span>
      <span data-testid="visible-tabs">{ctx.visibleTabIds.join('|')}</span>
      <span data-testid="active-tab">{ctx.activeTabId ?? ''}</span>
      <button
        type="button"
        onClick={() => void ctx.reconcileLocalRename({ renamed: [{ fromDocName, toDocName }] })}
      >
        Rename
      </button>
    </>
  );
}

function AuthRenameHarness() {
  const ctx = useDocumentContext();
  return (
    <button
      type="button"
      onClick={() =>
        ctx.openTarget(
          { kind: 'doc', target: 'from.md', docName: 'from.md' },
          { disposition: 'permanent', consumeActiveNewTab: true },
        )
      }
    >
      Select source
    </button>
  );
}

describe('DocumentContext local rename reconciliation — preserves tab position', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.location.hash = '';
  });

  test('renaming an open tab keeps its index in both openTabs and visibleTabIds', async () => {
    // Seed: [foo, bar]. Rename foo → bazz. Expected: tabs stay [bazz, bar].
    // Regression: previously the rename re-derived visibleTabIds via
    // reconcileVisibleTabOrder, which dropped the stale `foo` id and re-appended
    // the new `bazz` id at the end, producing [bar, bazz].
    seedRenameSession();
    render(<RenameHarness fromDocName="foo.md" toDocName="bazz.md" />, {
      wrapper: ProviderHarness,
    });

    expect(screen.getByTestId('open-tabs').textContent).toBe(`${RENAME_FOO}|${RENAME_BAR}`);
    expect(screen.getByTestId('visible-tabs').textContent).toBe(`${RENAME_FOO}|${RENAME_BAR}`);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(screen.getByTestId('open-tabs').textContent).toBe(`${RENAME_BAZZ}|${RENAME_BAR}`);
    expect(screen.getByTestId('visible-tabs').textContent).toBe(`${RENAME_BAZZ}|${RENAME_BAR}`);
  });

  test('renaming the active tab commits the remapped tab id to activeTabId', async () => {
    // Seed: [foo, bar], active = foo. Rename foo → bazz. Expected: activeTabId
    // flips from RENAME_FOO to RENAME_BAZZ via commitActiveTabId — without this
    // call, the active highlight would persist on the stale `foo` id even after
    // the tab itself was remapped, leaving the editor's active-tab UI desynced
    // from the rendered tab strip.
    seedRenameSession();
    render(<RenameHarness fromDocName="foo.md" toDocName="bazz.md" />, {
      wrapper: ProviderHarness,
    });

    expect(screen.getByTestId('active-tab').textContent).toBe(RENAME_FOO);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(screen.getByTestId('active-tab').textContent).toBe(RENAME_BAZZ);
  });

  test('renaming a non-active tab leaves activeTabId untouched', async () => {
    // Seed: [foo, bar], active = foo. Rename `bar` → `bazz`. Active stays foo —
    // the `if (remappedActiveTabId && next.includes(remappedActiveTabId))` guard
    // in local rename reconciliation only commits when the remapped active actually lands
    // in the next tab set; an unrelated rename must not perturb the active tab.
    seedRenameSession();
    render(<RenameHarness fromDocName="bar.md" toDocName="bazz.md" />, {
      wrapper: ProviderHarness,
    });

    expect(screen.getByTestId('active-tab').textContent).toBe(RENAME_FOO);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(screen.getByTestId('active-tab').textContent).toBe(RENAME_FOO);
  });

  test('auth rename navigates when the current target matches even if another pool doc is active', async () => {
    mockCollabUrl = 'ws://localhost:1/collab';
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;
    render(<AuthRenameHarness />, { wrapper: ProviderHarness });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Select source' }));

    const pool = (
      window as unknown as {
        __providerPool?: {
          open(docName: string): void;
          setActive(docName: string): void;
          onRenameRedirect?: (input: {
            fromDocName: string;
            toDocName: string;
            hadOpenProvider: boolean;
          }) => void;
        };
      }
    ).__providerPool;
    expect(pool).toBeDefined();
    pool?.open('other.md');
    pool?.setActive('other.md');

    act(() => {
      pool?.onRenameRedirect?.({
        fromDocName: 'from.md',
        toDocName: 'to.md',
        hadOpenProvider: true,
      });
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/to.md');
    });
  });
});

describe('DocumentContext skills-surface new tabs', () => {
  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  test('re-resolving the skills hub keeps the active new tab', async () => {
    render(<CloseActiveHarness />, { wrapper: ProviderHarness });
    const user = userEvent.setup();
    const newTabIds = () => (screen.getByTestId('new-tabs').textContent ?? '').split('|');
    const activeNewTabId = () => screen.getByTestId('active-new-tab').textContent;

    await user.click(screen.getByRole('button', { name: 'Show skills' }));
    await user.click(screen.getByRole('button', { name: 'Open new' }));

    const [first, second] = newTabIds();
    expect(first).toMatch(/^new-tab:skills:\d+$/);
    expect(second).toMatch(/^new-tab:skills:\d+$/);
    expect(activeNewTabId()).toBe(second);

    // The skills hub hash is the same for every skills new tab, so the nav
    // effect re-resolves it on unrelated re-renders. That must not move the
    // user off the tab they are on.
    await user.click(screen.getByRole('button', { name: 'Resolve skills hub' }));
    expect(activeNewTabId()).toBe(second);

    await user.click(screen.getByRole('button', { name: 'Activate first new tab' }));
    expect(activeNewTabId()).toBe(first);

    await user.click(screen.getByRole('button', { name: 'Resolve skills hub' }));
    expect(activeNewTabId()).toBe(first);
  });
});
