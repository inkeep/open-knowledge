/**
 * DOM mount test for CreateProjectMenuTrigger — the App-root surface that
 * opens CreateProjectDialog when main fires the `new-project` menu action
 * (File → New project…).
 *
 * Pins the user-visible contract: the dialog is closed until the menu action
 * fires, opens on `new-project`, and ignores unrelated menu actions. The
 * trigger subscribes to `bridge.onMenuAction`; this test captures the
 * subscribed callback through a fake bridge and invokes it directly — the
 * same path main's `sendMenuActionToFocused('new-project')` drives over IPC.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { CreateProjectMenuTrigger } from './CreateProjectMenuTrigger';

// `OkMenuAction` is module-private in desktop-bridge-types.ts; mirror just the
// members this test fires. The trigger only branches on the literal
// 'new-project', so an exact union is unnecessary.
type MenuActionLike = 'new-project' | 'new-doc' | 'toggle-sidebar';

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

interface MenuActionBridgeStub {
  bridge: OkDesktopBridge;
  /** Invoke the most recently subscribed onMenuAction callback. */
  fire(action: MenuActionLike): void;
  readonly unsubscribeCalls: number;
}

/**
 * Fake bridge exposing just the surface CreateProjectMenuTrigger +
 * CreateProjectDialog touch on open: `onMenuAction` (subscription) and
 * `fs.defaultProjectsRoot` (hydrated when the dialog opens). The captured
 * callback is fired by `fire(...)` to simulate main's menu dispatch.
 */
function makeMenuActionBridge(): MenuActionBridgeStub {
  let captured: ((action: MenuActionLike) => void) | null = null;
  let unsubscribeCalls = 0;

  const bridge = {
    onMenuAction: (cb: (action: MenuActionLike) => void) => {
      captured = cb;
      return () => {
        unsubscribeCalls += 1;
        captured = null;
      };
    },
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

  return {
    bridge,
    fire: (action) => {
      if (captured) {
        // Wrap in act so the resulting setOpen state flush is applied before
        // assertions run (mirrors fireEvent's internal act wrapping).
        act(() => captured?.(action));
      }
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
  };
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
    consoleWarnSpy.mockRestore();
  });

  test('dialog is closed until the new-project menu action fires', () => {
    const stub = makeMenuActionBridge();
    render(<CreateProjectMenuTrigger bridge={stub.bridge} />);
    // Radix Dialog renders nothing when closed — no portal, no testid.
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });

  test('new-project menu action opens CreateProjectDialog', async () => {
    const stub = makeMenuActionBridge();
    render(<CreateProjectMenuTrigger bridge={stub.bridge} />);

    stub.fire('new-project');

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
    const stub = makeMenuActionBridge();
    render(<CreateProjectMenuTrigger bridge={stub.bridge} />);

    stub.fire('new-doc');
    stub.fire('toggle-sidebar');

    // Give any erroneous open a chance to render before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('create-project-dialog') !== null).toBe(false);
  });

  test('unsubscribes from onMenuAction on unmount', () => {
    const stub = makeMenuActionBridge();
    const { unmount } = render(<CreateProjectMenuTrigger bridge={stub.bridge} />);
    expect(stub.unsubscribeCalls).toBe(0);
    unmount();
    expect(stub.unsubscribeCalls).toBe(1);
  });
});
