/**
 * DOM mount test for CreateProjectMenuTrigger — the App-root surface that
 * opens CreateProjectDialog when the `new-project` menu action fires
 * (File → New project…).
 *
 * Pins the user-visible contract: the dialog is closed until the menu action
 * fires, opens on `new-project`, and ignores unrelated menu actions. The
 * trigger subscribes to the renderer-local menu-action bus (a real menu click
 * reaches it via main → `ok:menu-action` → the bus forwarder), so this test
 * drives it with `emitLocalMenuAction`. The `bridge` prop is still threaded
 * into CreateProjectDialog, so the fake bridge keeps the surface the dialog
 * touches on open.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import { CreateProjectMenuTrigger } from './CreateProjectMenuTrigger';

// Radix UI primitives (shadcn Dialog) reach for DOM globals at mount. The
// broadly-needed constructors (MutationObserver) live in the shared
// tests/dom/jsdom-preload.ts; NodeFilter (react-focus-scope) and
// ResizeObserver (react-use-size) are hoisted locally per the sibling
// CreateProjectDialog.cascade-staleness.dom.test.tsx.
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

// Wrap the bus emit in act so the resulting setOpen state flush is applied
// before assertions run (mirrors fireEvent's internal act wrapping).
function fireMenuAction(action: Parameters<typeof emitLocalMenuAction>[0]): void {
  act(() => emitLocalMenuAction(action));
}

/**
 * Fake bridge exposing just the surface CreateProjectDialog touches on open:
 * `fs.defaultProjectsRoot` + a few project/dialog stubs. `onMenuAction` is no
 * longer read by the trigger (it listens on the bus), so it is omitted.
 */
function makeBridge(): OkDesktopBridge {
  return {
    fs: {
      defaultProjectsRoot: async (): Promise<string> => '/Users/test/Projects',
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
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // CreateProjectDialog's defaultProjectsRoot catch arm logs via
    // console.warn on unhappy paths; suppress to keep output clean.
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    consoleWarnSpy.mockRestore();
  });

  test('dialog is closed until the new-project menu action fires', () => {
    render(<CreateProjectMenuTrigger bridge={makeBridge()} />);
    // Radix Dialog renders nothing when closed — no portal, no testid.
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
    // The dialog title confirms it's the create-new-project surface.
    expect(screen.queryByText('Create new project') !== null).toBe(true);
  });

  test('unrelated menu actions do not open the dialog', async () => {
    render(<CreateProjectMenuTrigger bridge={makeBridge()} />);

    fireMenuAction('new-doc');
    fireMenuAction('toggle-sidebar');

    // Give any erroneous open a chance to render before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });

  test('unsubscribes from the bus on unmount', async () => {
    const { unmount } = render(<CreateProjectMenuTrigger bridge={makeBridge()} />);
    unmount();

    // After unmount the subscription is gone, so a later emit must not reopen.
    fireMenuAction('new-project');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });
});
