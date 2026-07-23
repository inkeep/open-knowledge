/**
 * DOM mount test for FeedbackMenuTrigger — the App-root surface that opens
 * FeedbackFormDialog when the `send-feedback` menu action fires
 * (Help → Send feedback…).
 *
 * Pins the user-visible contract: the dialog is closed until the menu action
 * fires, opens on `send-feedback`, and ignores unrelated menu actions. Driven
 * through `emitLocalMenuAction` — the same fan-out a real menu click hits via
 * main → `ok:menu-action` → the bus forwarder. Sibling of
 * ReportBugMenuTrigger.dom.test.tsx.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import { FeedbackMenuTrigger } from './FeedbackMenuTrigger';

// Radix UI primitives (shadcn Dialog) reach for DOM globals at mount. Hoisted
// locally per the sibling ReportBugMenuTrigger.dom.test.tsx.
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

describe('FeedbackMenuTrigger', () => {
  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
  });

  test('dialog is closed until the send-feedback menu action fires', () => {
    render(<FeedbackMenuTrigger />);
    // Radix Dialog renders nothing when closed — no portal, no dialog role.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('send-feedback menu action opens FeedbackFormDialog', async () => {
    render(<FeedbackMenuTrigger />);

    fireMenuAction('send-feedback');

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    // The dialog title confirms it's the feedback surface.
    expect(screen.getByRole('dialog', { name: 'How do you like OpenKnowledge?' })).not.toBeNull();
  });

  test('unrelated menu actions do not open the dialog', async () => {
    render(<FeedbackMenuTrigger />);

    fireMenuAction('new-doc');
    fireMenuAction('report-bug');

    // Give any erroneous open a chance to render before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('unsubscribes from the bus on unmount', async () => {
    const { unmount } = render(<FeedbackMenuTrigger />);
    unmount();

    // After unmount the subscription is gone, so a later emit must not reopen.
    fireMenuAction('send-feedback');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
