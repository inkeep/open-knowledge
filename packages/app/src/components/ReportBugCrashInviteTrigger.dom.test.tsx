import type {
  OkBugReportCrashDetectedEvent,
  OkBugReportCreateResult,
  ReportBundleSummary,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { crashInviteStore } from '@/lib/crash-invite-store';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { ReportBugCrashInviteTrigger } from './ReportBugCrashInviteTrigger';

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

const ASYNC_TIMEOUT_MS = 10_000;

const INVITE: OkBugReportCrashDetectedEvent = {
  eventId: 'boot:1751871600000',
  kind: 'boot',
  context: { dirtyShutdown: true, newMinidumps: 0 },
  minidumpAvailable: false,
};

const ZIP_PATH = '/Users/tester/.ok/bug-reports/2026-07-10T00-00-00-bugreport.zip';
const SUMMARY: ReportBundleSummary = {
  level: 'full',
  systemWide: false,
  projectSlug: 'demo-project',
  files: ['sysinfo.json'],
  redactions: [],
  redactedLineCount: 0,
  generatedAt: '2026-07-10T00:00:00.000Z',
};
const CREATE_OK: OkBugReportCreateResult = {
  ok: true,
  zipPath: ZIP_PATH,
  zipSizeBytes: 7130316,
  summary: SUMMARY,
};

interface CrashBridgeStub {
  bridge: OkDesktopBridge;
  fire(event: OkBugReportCrashDetectedEvent): void;
  readonly acked: string[];
  readonly sent: string[];
}

function makeCrashBridge(): CrashBridgeStub {
  let captured: ((event: OkBugReportCrashDetectedEvent) => void) | null = null;
  const acked: string[] = [];
  const sent: string[] = [];

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
      create: () => Promise.resolve(CREATE_OK),
      send: (request: { zipPath: string }) => {
        sent.push(request.zipPath);
        return Promise.resolve({ ok: true as const, reference: 'OK-CRASH1' });
      },
    },
  } as unknown as OkDesktopBridge;

  return {
    bridge,
    fire: (event) => {
      act(() => captured?.(event));
    },
    acked,
    sent,
  };
}

function installGlobalBridge(bridge: OkDesktopBridge) {
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', { configurable: true, writable: true, value: bridge });
  }
}

function clearGlobalBridge() {
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  }
}

function installCrashBridge(stub: CrashBridgeStub): (() => void) | undefined {
  crashInviteStore.install({ bridge: stub.bridge })?.();
  return crashInviteStore.install({ bridge: stub.bridge });
}

describe('ReportBugCrashInviteTrigger', () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    uninstall?.();
    uninstall = undefined;
    clearGlobalBridge();
  });

  test('a crash-detected push opens the crash-invite dialog', async () => {
    const stub = makeCrashBridge();
    uninstall = installCrashBridge(stub);
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
    uninstall = installCrashBridge(stub);
    stub.fire(INVITE);

    render(<ReportBugCrashInviteTrigger bridge={stub.bridge} />);

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('a superseding crash restarts the dialog instead of reusing the previous crash state', async () => {
    const stub = makeCrashBridge();
    uninstall = installCrashBridge(stub);
    render(<ReportBugCrashInviteTrigger bridge={stub.bridge} />);

    stub.fire(INVITE);
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.queryByRole('checkbox', { name: 'Crash dump' })).toBeNull();
    const noteBox = screen.getByRole('textbox', { name: /what were you doing/i });
    await userEvent.type(noteBox, 'I was editing a spec when the window blinked');

    stub.fire({
      eventId: 'crash:render:1751871900000:0',
      kind: 'render-process-gone',
      context: { reason: 'crashed', exitCode: 5 },
      minidumpAvailable: true,
    });

    await waitFor(
      () => {
        expect(
          screen.getByRole('checkbox', { name: 'Crash dump' }).getAttribute('data-state'),
        ).toBe('checked');
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(
      (screen.getByRole('textbox', { name: /what were you doing/i }) as HTMLTextAreaElement).value,
    ).toBe('');
  });

  test('Not now acks the crash event and closes the invitation', async () => {
    const stub = makeCrashBridge();
    uninstall = installCrashBridge(stub);
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

  test('sending the report acks the crash event, so the invitation cannot re-prompt', async () => {
    const stub = makeCrashBridge();
    installGlobalBridge(stub.bridge);
    uninstall = installCrashBridge(stub);
    render(<ReportBugCrashInviteTrigger bridge={stub.bridge} />);
    stub.fire(INVITE);
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(
      () => {
        expect(stub.sent).toEqual([ZIP_PATH]);
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(stub.acked).toEqual(['boot:1751871600000']);
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
  });

  test('dismissing via Escape also counts as the answer and acks', async () => {
    const stub = makeCrashBridge();
    uninstall = installCrashBridge(stub);
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
