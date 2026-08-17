/**
 * RTL mount tests for the top-level app-shell boundary: fallback render on a
 * shell crash, reset recovery, the bridge-gated report action, and the
 * nesting contract (document errors stay with DocumentErrorBoundary).
 * Invocation via `bun run test:dom`.
 */

import type { OkBugReportCreateResult } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  consumeHashNavigationSuppression,
  resetTabSessionRestoreSuppression,
  shouldSuppressTabSessionRestore,
} from '@/lib/tab-session-restore-suppression';
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
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shouldThrow = false;
    resetTabSessionRestoreSuppression();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    clearBugReportBridge();
    resetTabSessionRestoreSuppression();
    // The restore reset deliberately leaves the hash-navigation latch armed, so
    // a repeat-crash test would otherwise leak it into the next test in this
    // file (module scope is shared; isolate is per-file).
    consumeHashNavigationSuppression();
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

  test('a repeat crash on the same error stops Try again from replaying the persisted tab session', async () => {
    // Stands in for the document workspace: on each mount it consults the real
    // restore-suppression signal and, unless suppressed, "restores" the persisted
    // tab — which reopens the crashing document and re-throws, creating the crash
    // loop that makes Try again non-functional. Rendered state (alert vs recovered) is
    // the signal, not render count: React re-renders a throwing child several
    // times per trip, but onError (which records the trip) fires once.
    function RestoringWorkspace() {
      if (shouldSuppressTabSessionRestore()) {
        return <span data-testid="recovered-empty">recovered without the last document</span>;
      }
      throw new Error('restored-document boom');
    }

    render(
      <AppErrorBoundary>
        <RestoringWorkspace />
      </AppErrorBoundary>,
    );
    const user = userEvent.setup();

    // First trip: restoring the persisted tab crashed the shell.
    expect(screen.getByRole('alert')).not.toBeNull();
    expect(screen.queryByTestId('recovered-empty')).toBeNull();

    // Second trip: the first Try again restored again and the same crash fired
    // again — proof the first trip did NOT suppress (a single crash still restores).
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('alert')).not.toBeNull();
    expect(screen.queryByTestId('recovered-empty')).toBeNull();

    // The repeat has now armed suppression, so the next Try again recovers WITHOUT
    // replaying the persisted tab: the crashing document is not reopened.
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('recovered-empty')).not.toBeNull();
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

    // ReportBugDialog is lazy-loaded — await the body chunk mounting. This is
    // typically the first site in the suite to cold-load the chunk, so give it
    // generous headroom over findByRole's 1000ms default.
    expect(await screen.findByRole('dialog', {}, { timeout: 3000 })).not.toBeNull();
    const checkbox = screen.getByRole('checkbox', { name: 'Detailed diagnostics' });
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    // Navigator window → the logs hint is labeled system-wide.
    expect(
      screen.getByText(
        "App & system info and recent app logs. No project is open, so project logs aren't included.",
      ),
    ).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.level).toBe('full');
    const note = createCalls[0]?.note ?? '';
    expect(note).toContain('Crash source: app shell');
    expect(note).toContain('Error: MaybeThrow boom: shell');
    // React's component stack rides along: in a packaged build it is the only
    // part of a crash that still names a real component.
    expect(note).toContain('Component stack:');
    expect(note).toContain('at MaybeThrow');
    // Frame directories are trimmed, so the note cannot carry a home path.
    expect(note).not.toContain('/Users/');
  });

  test('does not intercept errors the per-document boundary already handles', () => {
    shouldThrow = true;
    installBugReportBridge();
    render(
      <AppErrorBoundary>
        <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={vi.fn(() => {})}>
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
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shouldThrow = false;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
