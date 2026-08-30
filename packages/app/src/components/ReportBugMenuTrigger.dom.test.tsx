/**
 * DOM mount test for ReportBugMenuTrigger — the App-root surface that opens
 * ReportBugDialog when the `report-bug` menu action fires (Help → Report a bug…).
 *
 * Pins the user-visible contract: the dialog is closed until the menu action
 * fires, opens on `report-bug`, and ignores unrelated menu actions. The trigger
 * now subscribes to the renderer-local menu-action bus (a real menu click
 * reaches it via main → `ok:menu-action` → the bus forwarder), so this test
 * drives it with `emitLocalMenuAction` — the same fan-out a menu click hits.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import { ReportBugMenuTrigger } from './ReportBugMenuTrigger';

// Surfaces the launcher-borne bit the trigger derives from the dispatch, so
// the origin's trip from the bus to the capture gate is assertable here. What
// the gate then DOES with it is the dialog's own test's business.
vi.mock('./ReportBugDialog', () => ({
  ReportBugDialog: ({ open, launcherBorne }: { open: boolean; launcherBorne?: boolean }) =>
    open ? (
      <div
        aria-label="Report a bug"
        data-launcher-borne={String(launcherBorne === true)}
        role="dialog"
      />
    ) : null,
}));

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

// Wrap the bus emit in act so the resulting state flush is applied before
// assertions run (mirrors fireEvent's internal act wrapping).
function fireMenuAction(
  action: Parameters<typeof emitLocalMenuAction>[0],
  origin?: Parameters<typeof emitLocalMenuAction>[1],
): void {
  act(() => emitLocalMenuAction(action, origin));
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

  test('pressing the chord in the renderer does not open the dialog', async () => {
    render(<ReportBugMenuTrigger />);

    // The chord reaches this trigger only as a menu action main dispatched
    // after the OS consumed the accelerator — never as a renderer keydown. A
    // listener added here would fire a second time on desktop AND would be
    // subject to the app-global overlay gate, which is the one thing the chord
    // must not be.
    //
    // Read off the binding rather than restated, so a rebind cannot leave this
    // probing a retired chord and passing for the wrong reason.
    const binding = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === 'report-bug')
      ?.bindings[0];
    const key = binding?.mac.trim().slice(-1).toLowerCase() as string;
    expect(key).toMatch(/^[a-z]$/);
    const code = `Key${key.toUpperCase()}`;
    fireEvent.keyDown(window, { key, code, metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key, code, ctrlKey: true, shiftKey: true });

    // Give any erroneous open a chance to render before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a native-menu dispatch opens a report that captures without waiting', async () => {
    render(<ReportBugMenuTrigger />);

    // The native Help menu and the keyboard accelerator both reach main with no
    // renderer sender, so nothing on screen was opened to get here.
    fireMenuAction('report-bug');

    const dialog = await screen.findByRole('dialog');
    expect(dialog.dataset.launcherBorne).toBe('false');
  });

  test('an in-app menubar dispatch opens a report that waits out the menu', async () => {
    render(<ReportBugMenuTrigger />);

    // The in-app menubar is a Radix popper — the primary menu surface on
    // Windows and Linux, where the native bar is hidden — so it is still
    // animating out as the report opens and must not land in the screenshot.
    fireMenuAction('report-bug', { launcherBorne: true });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.dataset.launcherBorne).toBe('true');
  });

  test('a second dispatch while open keeps the origin the capture was taken for', async () => {
    render(<ReportBugMenuTrigger />);

    fireMenuAction('report-bug');
    await screen.findByRole('dialog');
    fireMenuAction('report-bug', { launcherBorne: true });

    // The screenshot for this open cycle is already taken; re-marking it would
    // describe a capture that never happened.
    await waitFor(
      () => {
        expect(screen.getByRole('dialog').dataset.launcherBorne).toBe('false');
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
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
