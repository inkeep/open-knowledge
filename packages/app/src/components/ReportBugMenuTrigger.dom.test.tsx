/**
 * DOM mount test for ReportBugMenuTrigger — the App-root surface that opens
 * ReportBugDialog when main fires the `report-bug` menu action
 * (Help → Report a Bug…).
 *
 * Pins the user-visible contract: the dialog is closed until the menu action
 * fires, opens on `report-bug`, and ignores unrelated menu actions. The
 * trigger subscribes to `bridge.onMenuAction`; this test captures the
 * subscribed callback through a fake bridge and invokes it directly — the
 * same path main's `sendMenuActionToFocused('report-bug')` drives over IPC.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { ReportBugMenuTrigger } from './ReportBugMenuTrigger';

// `OkMenuAction` is module-private in desktop-bridge-types.ts; mirror just the
// members this test fires. The trigger only branches on the literal
// 'report-bug', so an exact union is unnecessary.
type MenuActionLike = 'report-bug' | 'new-doc' | 'toggle-sidebar';

// Radix UI primitives (shadcn Dialog) reach for DOM globals at mount. The
// broadly-needed constructors (MutationObserver) live in the shared
// tests/dom/jsdom-preload.ts; NodeFilter (react-focus-scope) and
// ResizeObserver (react-use-size) are hoisted locally per the sibling
// CreateProjectMenuTrigger.dom.test.tsx.
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
 * Fake bridge exposing just the surface ReportBugMenuTrigger touches:
 * `onMenuAction` (subscription). ReportBugDialog itself talks to
 * `window.okDesktop` only on user actions (create/send), which this test
 * never reaches — opening the compose phase needs no further bridge surface.
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

describe('ReportBugMenuTrigger', () => {
  afterEach(() => {
    cleanup();
  });

  test('dialog is closed until the report-bug menu action fires', () => {
    const stub = makeMenuActionBridge();
    render(<ReportBugMenuTrigger bridge={stub.bridge} />);
    // Radix Dialog renders nothing when closed — no portal, no dialog role.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('report-bug menu action opens ReportBugDialog', async () => {
    const stub = makeMenuActionBridge();
    render(<ReportBugMenuTrigger bridge={stub.bridge} />);

    stub.fire('report-bug');

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    // The dialog title confirms it's the report-a-bug surface.
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).not.toBeNull();
  });

  test('unrelated menu actions do not open the dialog', async () => {
    const stub = makeMenuActionBridge();
    render(<ReportBugMenuTrigger bridge={stub.bridge} />);

    stub.fire('new-doc');
    stub.fire('toggle-sidebar');

    // Give any erroneous open a chance to render before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('unsubscribes from onMenuAction on unmount', () => {
    const stub = makeMenuActionBridge();
    const { unmount } = render(<ReportBugMenuTrigger bridge={stub.bridge} />);
    expect(stub.unsubscribeCalls).toBe(0);
    unmount();
    expect(stub.unsubscribeCalls).toBe(1);
  });
});
