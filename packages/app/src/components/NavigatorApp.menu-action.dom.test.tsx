/**
 * DOM mount tests for NavigatorApp's menu-action subscription — the
 * launcher-window mirror of the editor-window App-root triggers
 * (`CreateProjectMenuTrigger`, `ReportBugMenuTrigger`). Both windows must
 * react when main fires a menu action since the menu dispatches to whichever
 * window is focused.
 *
 * Pins the user-visible contract: NavigatorApp's CreateProjectDialog opens
 * only after the `new-project` action fires, `report-bug` opens the
 * system-wide ReportBugDialog, and unrelated menu actions are ignored. The
 * subscription is captured via a fake bridge and invoked directly — the same
 * path main's `sendMenuActionToFocused(...)` drives over IPC.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';

// `next-themes` is consumed at the top of NavigatorApp; provide a stable
// stub so the test mount doesn't require a ThemeProvider.
mock.module('next-themes', () => ({
  useTheme: () => ({ theme: 'system' }),
}));

// `useThemeBridge` drives the cold-launch show-gate via real IPC calls
// (setThemeSource / signalThemeApplied). Stub to a no-op so the bridge stub
// doesn't need those methods.
mock.module('@/hooks/use-theme-bridge', () => ({
  useThemeBridge: () => {},
}));

const { NavigatorApp } = await import('./NavigatorApp');

// Radix UI primitives (shadcn Dialog) reach for DOM globals at mount. The
// broadly-needed constructors (MutationObserver) live in the shared
// tests/dom/jsdom-preload.ts; NodeFilter (react-focus-scope) and
// ResizeObserver (react-use-size) are hoisted locally per sibling DOM tests.
type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const ASYNC_TIMEOUT_MS = 2000;

type MenuActionLike =
  | 'new-project'
  | 'new-doc'
  | 'toggle-sidebar'
  | 'close-active-tab-or-window'
  | 'report-bug';

interface NavigatorBridgeStub {
  bridge: OkDesktopBridge;
  /** Invoke the most recently subscribed onMenuAction callback. */
  fire(action: MenuActionLike): void;
}

/**
 * Fake bridge exposing the surface NavigatorApp touches at mount + the
 * CreateProjectDialog open path. `onMenuAction` captures the subscribed
 * callback; `fire(...)` invokes it the way main's menu dispatch would.
 */
function makeNavigatorBridge(): NavigatorBridgeStub {
  const bridge = {
    config: {
      collabUrl: '',
      apiOrigin: '',
      projectPath: '',
      projectName: 'Project Navigator',
      mode: 'navigator',
    },
    onMenuAction: () => () => {},
    project: {
      listRecent: async () => [],
      removeRecent: async () => undefined,
      getSessionState: async () => ({
        openTabs: [],
        pinnedTabIds: [],
        activeDocName: null,
        activeTabId: null,
        updatedAt: null,
      }),
      setSessionState: async () => undefined,
      open: async () => undefined,
      createNew: async () => undefined,
      recordCreateNewBannerShown: async () => undefined,
      readHeadBranch: async () => ({
        currentBranch: null,
        headSha: null,
        detached: false,
      }),
      close: async () => undefined,
    },
    dialog: {
      openFolder: async (): Promise<string | null> => null,
    },
    fs: {
      defaultProjectsRoot: async (): Promise<string> => '/Users/test/Projects',
    },
  } as unknown as OkDesktopBridge;

  return {
    bridge,
    fire: (action) => {
      // Wrap in act so the resulting setOpen state flush is applied before
      // assertions run (mirrors fireEvent's internal act wrapping).
      act(() => emitLocalMenuAction(action));
    },
  };
}

describe('NavigatorApp new-project menu-action subscription', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // CreateProjectDialog's defaultProjectsRoot catch arm logs via
    // console.warn on unhappy paths; NavigatorApp's listRecent catch logs
    // via console.error. Suppress both to keep output clean.
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('CreateProjectDialog is closed until the new-project menu action fires', async () => {
    const stub = makeNavigatorBridge();
    render(<NavigatorApp bridge={stub.bridge} />);

    // Let listRecent's microtask settle so any post-mount render-cascade
    // finishes before we assert the dialog's absence.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });

  test('new-project menu action opens CreateProjectDialog', async () => {
    const stub = makeNavigatorBridge();
    render(<NavigatorApp bridge={stub.bridge} />);

    // Let listRecent's microtask settle so the subscription useEffect runs.
    await new Promise((r) => setTimeout(r, 0));

    stub.fire('new-project');

    await waitFor(
      () => {
        expect(screen.queryByTestId('create-project-dialog') !== null).toBe(true);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('unrelated menu actions do not open CreateProjectDialog', async () => {
    const stub = makeNavigatorBridge();
    render(<NavigatorApp bridge={stub.bridge} />);

    // Let listRecent's microtask settle so the subscription useEffect runs.
    await new Promise((r) => setTimeout(r, 0));

    stub.fire('new-doc');
    stub.fire('toggle-sidebar');

    // Give any erroneous open a chance to render before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });

  test('report-bug menu action opens the system-wide ReportBugDialog', async () => {
    const stub = makeNavigatorBridge();
    render(<NavigatorApp bridge={stub.bridge} />);

    // Let listRecent's microtask settle so the subscription useEffect runs.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('dialog')).toBeNull();

    stub.fire('report-bug');

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog', { name: 'Report a bug' })).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    // The Navigator has no project, so the compose summary must carry the
    // system-wide labeling rather than the project-scoped line.
    expect(screen.getByText(/No project is open/)).not.toBeNull();
  });

  test('close-active-tab-or-window menu action closes the navigator window', async () => {
    const closeSpy = spyOn(window, 'close').mockImplementation(() => {});
    const stub = makeNavigatorBridge();
    render(<NavigatorApp bridge={stub.bridge} />);

    // Let listRecent's microtask settle so the subscription useEffect runs.
    await new Promise((r) => setTimeout(r, 0));

    stub.fire('close-active-tab-or-window');

    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });
});
