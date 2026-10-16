import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BugReportCapture } from '@/lib/bug-report-capture';
import { KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import { installPointerPositionTracker } from '@/lib/pointer-position';
import { ReportBugMenuTrigger } from './ReportBugMenuTrigger';

vi.mock('./ReportBugDialog', () => ({
  ReportBugDialog: ({ capture }: { capture: BugReportCapture | null }) =>
    capture !== null ? (
      <div
        aria-label="Report a bug"
        data-pointer-marked={String(capture.pointerMarked)}
        role="dialog"
      />
    ) : null,
}));

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

function fireMenuAction(
  action: Parameters<typeof emitLocalMenuAction>[0],
  origin?: Parameters<typeof emitLocalMenuAction>[1],
): void {
  act(() => emitLocalMenuAction(action, origin));
}

function installCaptureBridge(): { calls: number } {
  const log = { calls: 0 };
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    writable: true,
    value: {
      bugReport: {
        captureScreenshot: () => {
          log.calls += 1;
          return Promise.resolve({
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            width: 1,
            height: 1,
          });
        },
      },
    },
  });
  return log;
}

describe('ReportBugMenuTrigger', () => {
  let stopPointerTracking: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    stopPointerTracking?.();
    stopPointerTracking = undefined;
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  function trackPointerAt(x: number, y: number): void {
    stopPointerTracking = installPointerPositionTracker();
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
  }

  test('dialog is closed until the report-bug menu action fires', () => {
    render(<ReportBugMenuTrigger />);
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
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).not.toBeNull();
  });

  test('unrelated menu actions do not open the dialog', async () => {
    render(<ReportBugMenuTrigger />);

    fireMenuAction('new-doc');
    fireMenuAction('toggle-sidebar');

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('pressing the chord in the renderer does not open the dialog', async () => {
    render(<ReportBugMenuTrigger />);

    const binding = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === 'report-bug')
      ?.bindings[0];
    const key = binding?.mac.trim().slice(-1).toLowerCase() as string;
    expect(key).toMatch(/^[a-z]$/);
    const code = `Key${key.toUpperCase()}`;
    fireEvent.keyDown(window, { key, code, metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key, code, ctrlKey: true, shiftKey: true });

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a native-menu dispatch opens a report whose shot marks the pointer', async () => {
    trackPointerAt(120, 80);
    installCaptureBridge();
    render(<ReportBugMenuTrigger />);

    fireMenuAction('report-bug');

    const dialog = await screen.findByRole('dialog');
    expect(dialog.dataset.pointerMarked).toBe('true');
  });

  test('an in-app menubar dispatch opens a report whose shot leaves the pointer unmarked', async () => {
    trackPointerAt(120, 80);
    installCaptureBridge();
    render(<ReportBugMenuTrigger />);

    fireMenuAction('report-bug', { launcherBorne: true });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.dataset.pointerMarked).toBe('false');
  });

  test('a second dispatch while open keeps the capture the first one took', async () => {
    trackPointerAt(120, 80);
    const log = installCaptureBridge();
    render(<ReportBugMenuTrigger />);

    fireMenuAction('report-bug');
    await screen.findByRole('dialog');
    fireMenuAction('report-bug', { launcherBorne: true });

    for (let frame = 0; frame < 3; frame++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(screen.getByRole('dialog').dataset.pointerMarked).toBe('true');
    expect(log.calls).toBe(1);
  });

  test('unsubscribes from the bus on unmount', async () => {
    const { unmount } = render(<ReportBugMenuTrigger />);
    unmount();

    fireMenuAction('report-bug');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
