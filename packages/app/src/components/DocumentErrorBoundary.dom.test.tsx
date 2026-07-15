/**
 * RTL mount tests for the DocumentErrorBoundary contract:
 * fallback render on throw, retry-handler invalidation. Exercises `render`
 * + `userEvent` under the jsdom substrate (precedent #43); invocation via
 * `bun run test:dom`. Throw injection follows the MaybeThrow Pattern C
 * documented in precedent #43(d).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { OkBugReportCreateResult } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as syncPromiseModule from '@/editor/sync-promise';
import { DocumentErrorBoundary, errorCopy } from './DocumentErrorBoundary';

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

function installBugReportBridge(): CreateRequest[] {
  const createCalls: CreateRequest[] = [];
  const bridge = {
    bugReport: {
      create: (request: CreateRequest) => {
        createCalls.push(request);
        const result: OkBugReportCreateResult = {
          ok: true,
          zipPath: '/tmp/report.zip',
          zipSizeBytes: 1024,
          summary: {
            level: request.level,
            systemWide: false,
            projectSlug: 'demo',
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

describe('DocumentErrorBoundary (Tier-3 mount)', () => {
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
    const onRecycle = mock(() => {});
    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle}>
        <MaybeThrow label="hello" />
      </DocumentErrorBoundary>,
    );
    expect(screen.getByTestId('payload').textContent).toBe('hello');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onRecycle).not.toHaveBeenCalled();
  });

  test('renders fallback UI with role=alert + heading + try-again button on child throw', () => {
    shouldThrow = true;
    const onRecycle = mock(() => {});
    const error = new Error('MaybeThrow boom: alpha');
    const { title } = errorCopy(error);

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-slot')).toBe('document-error-boundary');

    const heading = document.getElementById('document-error-title');
    expect(heading?.textContent).toBe(title);

    const tryAgain = screen.getByRole('button', { name: /try again/i });
    expect(tryAgain.tagName).toBe('BUTTON');

    expect(screen.queryByRole('button', { name: /go back/i })).toBeNull();
  });

  test('Try again invokes onRecycle BEFORE the bracket-prefix retry log fires', async () => {
    shouldThrow = true;
    const callOrder: string[] = [];
    const onRecycle = mock((docName: string) => {
      callOrder.push(`recycle:${docName}`);
    });
    consoleWarnSpy.mockImplementation((message: unknown) => {
      if (typeof message === 'string') callOrder.push(`warn:${message}`);
    });

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(onRecycle).toHaveBeenCalledTimes(1);
    expect(onRecycle.mock.calls[0]?.[0]).toBe('alpha.md');

    const recycleIdx = callOrder.findIndex((entry) => entry.startsWith('recycle:'));
    const warnIdx = callOrder.findIndex((entry) =>
      entry.startsWith('warn:[DocumentErrorBoundary] retry recycled'),
    );
    expect(recycleIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThan(recycleIdx);
  });

  test('renders Go back button when previousDocName + onNavigateBack are both set', () => {
    shouldThrow = true;
    const onRecycle = mock(() => {});
    const onNavigateBack = mock(() => {});

    render(
      <DocumentErrorBoundary
        activeDocName="alpha.md"
        previousDocName="beta.md"
        onNavigateBack={onNavigateBack}
        onRecycle={onRecycle}
      >
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /go back/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
  });

  test('Go back click navigates with previousDocName, invalidates sync promise, and does NOT call onRecycle', async () => {
    shouldThrow = true;
    const onRecycle = mock((_docName: string) => {});
    const onNavigateBack = mock((_previousDocName: string) => {});
    // Spy on the named export — ES module live binding lets DocumentErrorBoundary's
    // captured `invalidateSyncPromise` reference see the spy's mockImplementation.
    // This pins the load-bearing "back-nav clears the cached rejected sync
    // promise so re-visiting the errored doc later gets a fresh attempt"
    // contract at DocumentErrorBoundary.tsx.
    const invalidateSpy = spyOn(syncPromiseModule, 'invalidateSyncPromise').mockImplementation(
      () => {},
    );

    render(
      <DocumentErrorBoundary
        activeDocName="alpha.md"
        previousDocName="beta.md"
        onNavigateBack={onNavigateBack}
        onRecycle={onRecycle}
      >
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /go back/i }));

    expect(onNavigateBack).toHaveBeenCalledTimes(1);
    expect(onNavigateBack.mock.calls[0]?.[0]).toBe('beta.md');
    expect(onRecycle).not.toHaveBeenCalled();
    // Cache-invalidation contract.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy.mock.calls[0]?.[0]).toBe('alpha.md');

    const sawBackNavWarn = consoleWarnSpy.mock.calls.some((call: unknown[]) => {
      const message = call[0];
      return typeof message === 'string' && message.includes('back-nav reset (no recycle)');
    });
    expect(sawBackNavWarn).toBe(true);

    invalidateSpy.mockRestore();
  });

  test('Report this error opens the report dialog with full detail and the crash context in the note', async () => {
    shouldThrow = true;
    const createCalls = installBugReportBridge();
    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={mock(() => {})}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /report this error/i }));

    // ReportBugDialog is lazy-loaded — await the body chunk mounting.
    expect(await screen.findByRole('dialog')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Report a bug' })).not.toBeNull();
    const checkbox = screen.getByRole('checkbox', { name: 'Include detailed diagnostics' });
    expect(checkbox.getAttribute('aria-checked')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(createCalls).toEqual([
      {
        level: 'full',
        note: 'Crash source: document view\nDocument: alpha.md\nError: MaybeThrow boom: alpha',
      },
    ]);
  });

  test('the report action is absent without the desktop bridge', () => {
    shouldThrow = true;
    clearBugReportBridge();
    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={mock(() => {})}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /try again/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /report this error/i })).toBeNull();
  });

  test('onError logs bracket-prefix console.error including the doc name and error title', () => {
    shouldThrow = true;
    const onRecycle = mock(() => {});
    const error = new Error('MaybeThrow boom: alpha');
    const { title } = errorCopy(error);

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const sawBoundaryError = consoleErrorSpy.mock.calls.some((call: unknown[]) => {
      const message = call[0];
      return (
        typeof message === 'string' &&
        message.includes('[DocumentErrorBoundary]') &&
        message.includes('alpha.md') &&
        message.includes(title)
      );
    });
    expect(sawBoundaryError).toBe(true);
  });
});
