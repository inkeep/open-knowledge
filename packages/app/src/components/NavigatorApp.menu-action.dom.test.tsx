import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';

vi.doMock('next-themes', () => ({
  useTheme: () => ({ theme: 'system' }),
}));

vi.doMock('@/hooks/use-theme-bridge', () => ({
  useThemeBridge: () => {},
}));

const { NavigatorApp } = await import('./NavigatorApp');

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
  | 'report-bug'
  | 'send-feedback';

interface NavigatorBridgeStub {
  bridge: OkDesktopBridge;
  fire(action: MenuActionLike): void;
}

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
    onRecentRemovedMissing: () => () => {},
    integrations: {
      status: async () => ({
        available: false,
        editors: [],
        path: { shellDetected: false, rcFilesToTouch: [], installed: false },
        skills: [],
        detectedEditorIds: [],
      }),
    },
    project: {
      listRecent: async () => [],
      removeRecent: async () => undefined,
      getSessionState: async () => ({
        updatedAt: null,
        panes: [
          {
            id: 'pane-main',
            openTabs: [],
            pinnedTabIds: [],
            activeTabId: null,
            size: 100,
          },
        ],
        focusedPaneId: 'pane-main',
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
      act(() => emitLocalMenuAction(action));
    },
  };
}

describe('NavigatorApp new-project menu-action subscription', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('CreateProjectDialog is closed until the new-project menu action fires', async () => {
    const stub = makeNavigatorBridge();
    render(
      <TooltipProvider>
        <NavigatorApp bridge={stub.bridge} />
      </TooltipProvider>,
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });

  test('new-project menu action opens CreateProjectDialog', async () => {
    const stub = makeNavigatorBridge();
    render(
      <TooltipProvider>
        <NavigatorApp bridge={stub.bridge} />
      </TooltipProvider>,
    );

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
    render(
      <TooltipProvider>
        <NavigatorApp bridge={stub.bridge} />
      </TooltipProvider>,
    );

    await new Promise((r) => setTimeout(r, 0));

    stub.fire('new-doc');
    stub.fire('toggle-sidebar');

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });

  test('report-bug menu action opens the system-wide ReportBugDialog', async () => {
    const stub = makeNavigatorBridge();
    render(
      <TooltipProvider>
        <NavigatorApp bridge={stub.bridge} />
      </TooltipProvider>,
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('dialog')).toBeNull();

    stub.fire('report-bug');

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog', { name: 'Report a bug' })).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.getByText(/No project is open/)).not.toBeNull();
  });

  test('closing the report leaves it reopenable', async () => {
    const stub = makeNavigatorBridge();
    render(
      <TooltipProvider>
        <NavigatorApp bridge={stub.bridge} />
      </TooltipProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));

    stub.fire('report-bug');
    await screen.findByRole('dialog', { name: 'Report a bug' }, { timeout: ASYNC_TIMEOUT_MS });

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Report a bug' })).toBeNull();
    });

    stub.fire('report-bug');
    expect(
      await screen.findByRole('dialog', { name: 'Report a bug' }, { timeout: ASYNC_TIMEOUT_MS }),
    ).not.toBeNull();
  });

  test('send-feedback menu action opens the feedback form', async () => {
    const stub = makeNavigatorBridge();
    render(
      <TooltipProvider>
        <NavigatorApp bridge={stub.bridge} />
      </TooltipProvider>,
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('dialog')).toBeNull();

    stub.fire('send-feedback');

    await waitFor(
      () => {
        expect(
          screen.queryByRole('dialog', { name: 'How do you like OpenKnowledge?' }),
        ).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('close-active-tab-or-window menu action closes the navigator window', async () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    const stub = makeNavigatorBridge();
    render(
      <TooltipProvider>
        <NavigatorApp bridge={stub.bridge} />
      </TooltipProvider>,
    );

    await new Promise((r) => setTimeout(r, 0));

    stub.fire('close-active-tab-or-window');

    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });
});
