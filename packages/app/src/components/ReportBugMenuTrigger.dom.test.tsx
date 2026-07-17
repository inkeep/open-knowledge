/**
 * DOM mount test for ReportBugMenuTrigger — the App-root surface that opens
 * ReportBugDialog when the `report-bug` menu action fires (Help → Report a Bug…).
 *
 * Pins the user-visible contract: the dialog is closed until the menu action
 * fires, opens on `report-bug`, and ignores unrelated menu actions. The trigger
 * now subscribes to the renderer-local menu-action bus (a real menu click
 * reaches it via main → `ok:menu-action` → the bus forwarder), so this test
 * drives it with `emitLocalMenuAction` — the same fan-out a menu click hits.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import { ReportBugMenuTrigger } from './ReportBugMenuTrigger';

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

// Wrap the bus emit in act so the resulting setOpen state flush is applied
// before assertions run (mirrors fireEvent's internal act wrapping).
function fireMenuAction(action: Parameters<typeof emitLocalMenuAction>[0]): void {
  act(() => emitLocalMenuAction(action));
}

describe('ReportBugMenuTrigger', () => {
  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
  });

  test('dialog is closed until the report-bug menu action fires', () => {
    render(<ReportBugMenuTrigger />);
    // Radix Dialog renders nothing when closed — no portal, no dialog role.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('report-bug menu action opens ReportBugDialog', async () => {
    render(<ReportBugMenuTrigger />);

    fireMenuAction('report-bug');

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
    render(<ReportBugMenuTrigger />);

    fireMenuAction('new-doc');
    fireMenuAction('toggle-sidebar');

    // Give any erroneous open a chance to render before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('unsubscribes from the bus on unmount', async () => {
    const { unmount } = render(<ReportBugMenuTrigger />);
    unmount();

    // After unmount the subscription is gone, so a later emit must not reopen.
    fireMenuAction('report-bug');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
