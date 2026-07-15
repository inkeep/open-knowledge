/**
 * RTL mount tests for the top-level app-shell boundary: fallback render on a
 * shell crash, reset recovery, the bridge-gated report action, and the
 * nesting contract (document errors stay with DocumentErrorBoundary).
 * Invocation via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { OkBugReportCreateResult } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppErrorBoundary, CrashReportingBoundary } from './AppErrorBoundary';
import { DocumentErrorBoundary } from './DocumentErrorBoundary';

// Radix Dialog (focus trap) reaches for DOM globals the jsdom preload does not
// expose on globalThis. Same hoist as CloneDialog.dom.test.tsx.
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

let shouldThrow = false;

function MaybeThrow({ label }: { label: string }) {
  if (shouldThrow) {
    throw new Error(`MaybeThrow boom: ${label}`);
  }
  return <span data-testid="payload">{label}</span>;
}

type CreateRequest = { level: 'standard' | 'full'; note?: string };

function installBugReportBridge(mode: 'editor' | 'navigator' = 'editor'): CreateRequest[] {
  const createCalls: CreateRequest[] = [];
  const bridge = {
    config: { mode },
    bugReport: {
      create: (request: CreateRequest) => {
        createCalls.push(request);
        const result: OkBugReportCreateResult = {
          ok: true,
          zipPath: '/tmp/report.zip',
          zipSizeBytes: 1024,
          summary: {
            level: request.level,
            systemWide: mode === 'navigator',
            projectSlug: undefined,
            files: [],
            redactions: [],
            redactedLineCount: 0,
            generatedAt: '2026-07-10T00:00:00.000Z',
          },
        };
        return Promise.resolve(result);
      },
      send: () => Promise.resolve({ ok: true as const, reference: 'OK-TEST01' }),
    },
    shell: {
      showItemInFolder: () => Promise.resolve(),
      openExternal: () => Promise.resolve(),
    },
  };
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', { configurable: true, writable: true, value: bridge });
  }
  return createCalls;
}

function clearBugReportBridge() {
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  }
}

describe('AppErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    shouldThrow = false;
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    clearBugReportBridge();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('renders children when no throw', () => {
    render(
      <AppErrorBoundary>
        <MaybeThrow label="shell" />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('payload').textContent).toBe('shell');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a shell crash renders the fallback with the error message and focuses Try again', () => {
    shouldThrow = true;
    installBugReportBridge();
    render(
      <AppErrorBoundary>
        <MaybeThrow label="shell" />
      </AppErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-slot')).toBe('app-error-boundary');
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).not.toBeNull();
    expect(screen.getByText('MaybeThrow boom: shell')).not.toBeNull();

    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    expect(document.activeElement).toBe(tryAgain);
    expect(screen.getByRole('button', { name: /report this error/i })).not.toBeNull();

    const sawBoundaryError = consoleErrorSpy.mock.calls.some((call: unknown[]) => {
      const message = call[0];
      return typeof message === 'string' && message.includes('[AppErrorBoundary]');
    });
    expect(sawBoundaryError).toBe(true);
  });

  test('Try again resets the boundary and re-renders the shell', async () => {
    shouldThrow = true;
    installBugReportBridge();
    render(
      <AppErrorBoundary>
        <MaybeThrow label="shell" />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole('alert')).not.toBeNull();

    shouldThrow = false;
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByTestId('payload').textContent).toBe('shell');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('Report this error opens the report dialog with full detail and the shell crash in the note', async () => {
    shouldThrow = true;
    const createCalls = installBugReportBridge('navigator');
    render(
      <AppErrorBoundary>
        <MaybeThrow label="shell" />
      </AppErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /report this error/i }));

    // ReportBugDialog is lazy-loaded — await the body chunk mounting.
    expect(await screen.findByRole('dialog')).not.toBeNull();
    const checkbox = screen.getByRole('checkbox', { name: 'Include detailed diagnostics' });
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    // Navigator window → the compose summary is labeled system-wide.
    expect(
      screen.getByText(
        'App & system info, recent app logs — no project is open, so no project logs are included.',
      ),
    ).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(createCalls).toEqual([
      {
        level: 'full',
        note: 'Crash source: app shell\nError: MaybeThrow boom: shell',
      },
    ]);
  });

  test('does not intercept errors the per-document boundary already handles', () => {
    shouldThrow = true;
    installBugReportBridge();
    render(
      <AppErrorBoundary>
        <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={mock(() => {})}>
          <MaybeThrow label="alpha" />
        </DocumentErrorBoundary>
      </AppErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-slot')).toBe('document-error-boundary');
    expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull();
  });

  test('the report action is absent without the desktop bridge', () => {
    shouldThrow = true;
    clearBugReportBridge();
    render(
      <AppErrorBoundary>
        <MaybeThrow label="shell" />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /report this error/i })).toBeNull();
  });
});

describe('CrashReportingBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    shouldThrow = false;
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
  });

  test('passes a healthy crash-reporting subtree through untouched', () => {
    render(
      <CrashReportingBoundary>
        <MaybeThrow label="invite" />
      </CrashReportingBoundary>,
    );
    expect(screen.getByTestId('payload').textContent).toBe('invite');
  });

  test('a throwing crash-invite subtree renders nothing and leaves the app alive', () => {
    // The trigger mounts as a sibling of the shell boundary, so nothing else
    // can catch its throws — without this boundary the whole root unmounts.
    shouldThrow = true;
    render(
      <div>
        <CrashReportingBoundary>
          <MaybeThrow label="invite" />
        </CrashReportingBoundary>
        <span data-testid="app-shell">still rendering</span>
      </div>,
    );

    expect(screen.queryByTestId('payload')).toBeNull();
    expect(screen.getByTestId('app-shell').textContent).toBe('still rendering');

    const sawBoundaryError = consoleErrorSpy.mock.calls.some((call: unknown[]) => {
      const message = call[0];
      return typeof message === 'string' && message.includes('[CrashReportingBoundary]');
    });
    expect(sawBoundaryError).toBe(true);
  });
});
