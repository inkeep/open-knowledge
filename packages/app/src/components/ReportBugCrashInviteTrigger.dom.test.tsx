/**
 * DOM mount tests for ReportBugCrashInviteTrigger — the per-window host that
 * opens ReportBugDialog's crash-invite variant when desktop main pushes a
 * crash-detected event.
 *
 * The trigger reads the module-init `crash-invite-store`; these tests install
 * the store against a fake bridge and fire the captured subscription callback
 * directly — the same path main's `ok:bug-report:crash-detected` push drives
 * over IPC. The buffered-delivery test pins the load-order contract: a
 * boot-time invitation delivered before React mounts must still surface.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { OkBugReportCrashDetectedEvent } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { crashInviteStore } from '@/lib/crash-invite-store';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { ReportBugCrashInviteTrigger } from './ReportBugCrashInviteTrigger';

// Radix UI primitives (shadcn Dialog) reach for DOM globals at mount — the
// same NodeFilter/ResizeObserver hoist as the sibling trigger test.
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

const INVITE: OkBugReportCrashDetectedEvent = {
  eventId: 'boot:1751871600000',
  kind: 'boot',
  context: { dirtyShutdown: true, newMinidumps: 0 },
};

interface CrashBridgeStub {
  bridge: OkDesktopBridge;
  /** Deliver a crash-detected event through the captured subscription. */
  fire(event: OkBugReportCrashDetectedEvent): void;
  readonly acked: string[];
}

/**
 * Fake bridge exposing just the surface the trigger and store touch:
 * `bugReport.onCrashDetected` (subscription), `bugReport.crashAck`, and
 * `config.mode`. The dialog's own bridge calls (create/send) are user-action
 * driven and these tests never reach them.
 */
function makeCrashBridge(): CrashBridgeStub {
  let captured: ((event: OkBugReportCrashDetectedEvent) => void) | null = null;
  const acked: string[] = [];

  const bridge = {
    config: { mode: 'editor' },
    bugReport: {
      onCrashDetected: (cb: (event: OkBugReportCrashDetectedEvent) => void) => {
        captured = cb;
        return () => {
          captured = null;
        };
      },
      crashAck: (request: { eventId: string }) => {
        acked.push(request.eventId);
        return Promise.resolve({ ok: true as const });
      },
    },
  } as unknown as OkDesktopBridge;

  return {
    bridge,
    fire: (event) => {
      // act() flushes the store-driven useSyncExternalStore update.
      act(() => captured?.(event));
    },
    acked,
  };
}

describe('ReportBugCrashInviteTrigger', () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    // Detach the singleton store from the test bridge and drop any buffered
    // invitation so state never leaks across tests.
    uninstall?.();
    uninstall = undefined;
  });

  test('a crash-detected push opens the crash-invite dialog', async () => {
    const stub = makeCrashBridge();
    uninstall = crashInviteStore.install({ bridge: stub.bridge });
    render(<ReportBugCrashInviteTrigger bridge={stub.bridge} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    stub.fire(INVITE);

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.getByText('OpenKnowledge quit unexpectedly last time.')).not.toBeNull();
  });

  test('an invitation delivered before the component mounts is buffered, not dropped', async () => {
    const stub = makeCrashBridge();
    uninstall = crashInviteStore.install({ bridge: stub.bridge });
    stub.fire(INVITE);

    render(<ReportBugCrashInviteTrigger bridge={stub.bridge} />);

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('Not now acks the crash event and closes the invitation', async () => {
    const stub = makeCrashBridge();
    uninstall = crashInviteStore.install({ bridge: stub.bridge });
    render(<ReportBugCrashInviteTrigger bridge={stub.bridge} />);
    stub.fire(INVITE);
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(stub.acked).toEqual(['boot:1751871600000']);
  });

  test('dismissing via Escape also counts as the answer and acks', async () => {
    const stub = makeCrashBridge();
    uninstall = crashInviteStore.install({ bridge: stub.bridge });
    render(<ReportBugCrashInviteTrigger bridge={stub.bridge} />);
    stub.fire(INVITE);
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    await userEvent.keyboard('{Escape}');

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(stub.acked).toEqual(['boot:1751871600000']);
  });
});
