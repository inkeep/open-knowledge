import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import { FeedbackMenuTrigger } from './FeedbackMenuTrigger';

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

describe('FeedbackMenuTrigger', () => {
  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
  });

  test('dialog is closed until the send-feedback menu action fires', () => {
    render(<FeedbackMenuTrigger />);
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
    expect(screen.getByRole('dialog', { name: 'How do you like OpenKnowledge?' })).not.toBeNull();
  });

  test('unrelated menu actions do not open the dialog', async () => {
    render(<FeedbackMenuTrigger />);

    fireMenuAction('new-doc');
    fireMenuAction('report-bug');

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('unsubscribes from the bus on unmount', async () => {
    const { unmount } = render(<FeedbackMenuTrigger />);
    unmount();

    fireMenuAction('send-feedback');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
