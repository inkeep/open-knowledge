import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import { CreateProjectMenuTrigger } from './CreateProjectMenuTrigger';

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

function fireMenuAction(action: Parameters<typeof emitLocalMenuAction>[0]): void {
  act(() => emitLocalMenuAction(action));
}

function makeBridge(): OkDesktopBridge {
  return {
    fs: {
      defaultProjectsRoot: async (): Promise<string> => '/Users/test/Projects',
    },
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
      recordCreateNewBannerShown: async () => undefined,
      createNew: async () => undefined,
      open: async () => undefined,
    },
    dialog: {
      openFolder: async (): Promise<string | null> => null,
    },
  } as unknown as OkDesktopBridge;
}

describe('CreateProjectMenuTrigger', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    consoleWarnSpy.mockRestore();
  });

  test('dialog is closed until the new-project menu action fires', () => {
    render(<CreateProjectMenuTrigger bridge={makeBridge()} />);
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });

  test('new-project menu action opens CreateProjectDialog', async () => {
    render(<CreateProjectMenuTrigger bridge={makeBridge()} />);

    fireMenuAction('new-project');

    await waitFor(
      () => {
        expect(screen.queryByTestId('create-project-dialog') !== null).toBe(true);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.queryByText('Create new project') !== null).toBe(true);
  });

  test('unrelated menu actions do not open the dialog', async () => {
    render(<CreateProjectMenuTrigger bridge={makeBridge()} />);

    fireMenuAction('new-doc');
    fireMenuAction('toggle-sidebar');

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });

  test('unsubscribes from the bus on unmount', async () => {
    const { unmount } = render(<CreateProjectMenuTrigger bridge={makeBridge()} />);
    unmount();

    fireMenuAction('new-project');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });
});
