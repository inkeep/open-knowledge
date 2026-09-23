/**
 * Exercises `render` + `userEvent` under the jsdom substrate (precedent #43). Throw injection
 * follows the MaybeThrow Pattern C documented in precedent #43(d).
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { OkBugReportCreateResult } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as syncPromiseModule from '@/editor/sync-promise';
import { DocumentNotFoundError, SyncTimeoutError } from '@/editor/sync-promise';
import { DocumentErrorBoundary, errorCopy } from './DocumentErrorBoundary';

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

function ThrowSyncTimeout({ docName }: { docName: string }) {
  if (shouldThrow) {
    throw new SyncTimeoutError(docName, 10_000);
  }
  return <span data-testid="payload">{docName}</span>;
}

function ThrowDocumentNotFound({ docName }: { docName: string }) {
  if (shouldThrow) {
    throw new DocumentNotFoundError(docName);
  }
  return <span data-testid="payload">{docName}</span>;
}

interface FakeProvider {
  provider: HocuspocusProvider;
  emitSynced: (state: boolean) => void;
  listenerCount: () => number;
}

function makeFakeProvider(initiallySynced: boolean): FakeProvider {
  const listeners = new Set<(payload: { state: boolean }) => void>();
  const provider = {
    isSynced: initiallySynced,
    on: (event: string, handler: (payload: { state: boolean }) => void) => {
      if (event === 'synced') listeners.add(handler);
    },
    off: (event: string, handler: (payload: { state: boolean }) => void) => {
      if (event === 'synced') listeners.delete(handler);
    },
  };
  return {
    provider: provider as unknown as HocuspocusProvider,
    emitSynced: (state: boolean) => {
      provider.isSynced = state;
      for (const handler of Array.from(listeners)) handler({ state });
    },
    listenerCount: () => listeners.size,
  };
}

type CreateRequest = { level: 'standard' | 'full'; note?: string };

const restartServer = vi.fn(async () => ({ ok: true as const }));

function installBugReportBridge(): CreateRequest[] {
  const createCalls: CreateRequest[] = [];
  const bridge = {
    config: { projectPath: '/tmp/ok', collabUrl: 'ws://127.0.0.1:5200/collab' },
    restartServer,
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
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shouldThrow = false;
    restartServer.mockClear();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    clearBugReportBridge();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('renders children when no throw', () => {
    const onRecycle = vi.fn(() => {});
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
    const onRecycle = vi.fn(() => {});
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
    const onRecycle = vi.fn((docName: string) => {
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
    const onRecycle = vi.fn(() => {});
    const onNavigateBack = vi.fn(() => {});

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
    const onRecycle = vi.fn((_docName: string) => {});
    const onNavigateBack = vi.fn((_previousDocName: string) => {});
    const invalidateSpy = vi
      .spyOn(syncPromiseModule, 'invalidateSyncPromise')
      .mockImplementation(() => {});

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
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={vi.fn(() => {})}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /report this error/i }));

    expect(await screen.findByRole('dialog', undefined, { timeout: 5000 })).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Report a bug' })).not.toBeNull();
    const checkbox = screen.getByRole('checkbox', { name: 'Detailed diagnostics' });
    expect(checkbox.getAttribute('aria-checked')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.level).toBe('full');
    const note = createCalls[0]?.note ?? '';
    expect(note).toContain('Crash source: document view');
    expect(note).toContain('Document: alpha.md');
    expect(note).toContain('Error: MaybeThrow boom: alpha');
    expect(note).toContain('Component stack:');
    expect(note).toContain('at MaybeThrow');
    expect(note).not.toContain('/Users/');
  });

  test('the report action is absent without the desktop bridge', () => {
    shouldThrow = true;
    clearBugReportBridge();
    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={vi.fn(() => {})}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /try again/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /report this error/i })).toBeNull();
  });

  test('onError logs bracket-prefix console.error including the doc name and error title', () => {
    shouldThrow = true;
    const onRecycle = vi.fn(() => {});
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

  test('the restart action is disabled while a restart is in flight', async () => {
    shouldThrow = true;
    installBugReportBridge();
    let releaseRestart!: (value: { ok: true }) => void;
    restartServer.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          releaseRestart = resolve;
        }),
    );

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={vi.fn(() => {})}>
        <ThrowSyncTimeout docName="alpha.md" />
      </DocumentErrorBoundary>,
    );

    const restart = screen.getByRole('button', { name: /restart server/i });
    await userEvent.click(restart);
    expect((restart as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(restart);
    expect(restartServer).toHaveBeenCalledTimes(1);

    releaseRestart({ ok: true });
    await screen.findByRole('button', { name: /restart server/i });
    expect((restart as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('DocumentErrorBoundary — bounded automatic retry', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  const warnMessages: string[] = [];

  beforeEach(() => {
    shouldThrow = false;
    warnMessages.length = 0;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      if (typeof message === 'string') warnMessages.push(message);
    });
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('a sync timeout over an already-synced provider retries itself and clears', async () => {
    shouldThrow = true;
    const { provider } = makeFakeProvider(true);
    const onRecycle = vi.fn(() => {
      shouldThrow = false;
    });

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle} provider={provider}>
        <ThrowSyncTimeout docName="alpha.md" />
      </DocumentErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId('payload').textContent).toBe('alpha.md');
    });
    expect(onRecycle).toHaveBeenCalledTimes(1);
    expect(onRecycle.mock.calls[0]?.[0]).toBe('alpha.md');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a provider that is not yet synced retries only once it reports synced', async () => {
    shouldThrow = true;
    const fake = makeFakeProvider(false);
    const onRecycle = vi.fn(() => {
      shouldThrow = false;
    });

    render(
      <DocumentErrorBoundary
        activeDocName="alpha.md"
        onRecycle={onRecycle}
        provider={fake.provider}
      >
        <ThrowSyncTimeout docName="alpha.md" />
      </DocumentErrorBoundary>,
    );

    await waitFor(() => {
      expect(fake.listenerCount()).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(onRecycle).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeDefined();

    fake.emitSynced(true);

    await waitFor(() => {
      expect(screen.getByTestId('payload').textContent).toBe('alpha.md');
    });
    expect(onRecycle).toHaveBeenCalledTimes(1);
  });

  test('an error that is not a server-reach error is never retried', async () => {
    shouldThrow = true;
    const { provider } = makeFakeProvider(true);
    const onRecycle = vi.fn(() => {
      shouldThrow = false;
    });

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle} provider={provider}>
        <ThrowDocumentNotFound docName="alpha.md" />
      </DocumentErrorBoundary>,
    );

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(onRecycle).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeDefined();
  });

  test('no provider means no automatic retry', async () => {
    shouldThrow = true;
    const onRecycle = vi.fn(() => {
      shouldThrow = false;
    });

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle}>
        <ThrowSyncTimeout docName="alpha.md" />
      </DocumentErrorBoundary>,
    );

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(onRecycle).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeDefined();
  });

  test('a document that keeps failing stops after three attempts and keeps its error UI', async () => {
    shouldThrow = true;
    const { provider } = makeFakeProvider(true);
    const onRecycle = vi.fn(() => {});

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle} provider={provider}>
        <ThrowSyncTimeout docName="alpha.md" />
      </DocumentErrorBoundary>,
    );

    await waitFor(
      () => {
        expect(warnMessages.some((m) => m.includes('auto-retry budget spent'))).toBe(true);
      },
      { timeout: 5_000 },
    );

    expect(onRecycle).toHaveBeenCalledTimes(3);
    expect(warnMessages.filter((m) => m.includes('auto-retry 1/3')).length).toBe(1);
    expect(warnMessages.filter((m) => m.includes('auto-retry 2/3')).length).toBe(1);
    expect(warnMessages.filter((m) => m.includes('auto-retry 3/3')).length).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(onRecycle).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('alert')).toBeDefined();
  });

  test("StrictMode's double-invoked effect does not spend a second attempt on one failure", async () => {
    shouldThrow = true;
    const { provider } = makeFakeProvider(true);
    const onRecycle = vi.fn(() => {
      shouldThrow = false;
    });

    render(
      <StrictMode>
        <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle} provider={provider}>
          <ThrowSyncTimeout docName="alpha.md" />
        </DocumentErrorBoundary>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('payload').textContent).toBe('alpha.md');
    });

    expect(onRecycle).toHaveBeenCalledTimes(1);
    expect(warnMessages.filter((m) => m.includes('auto-retry 1/3')).length).toBe(1);
    expect(warnMessages.filter((m) => m.includes('auto-retry 2/3')).length).toBe(0);
  });

  test('under StrictMode a document that keeps failing still gets three real attempts', async () => {
    shouldThrow = true;
    const { provider } = makeFakeProvider(true);
    const onRecycle = vi.fn(() => {});

    render(
      <StrictMode>
        <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle} provider={provider}>
          <ThrowSyncTimeout docName="alpha.md" />
        </DocumentErrorBoundary>
      </StrictMode>,
    );

    await waitFor(
      () => {
        expect(warnMessages.some((m) => m.includes('auto-retry budget spent'))).toBe(true);
      },
      { timeout: 5_000 },
    );

    expect(onRecycle).toHaveBeenCalledTimes(3);
    expect(warnMessages.filter((m) => m.includes('auto-retry 1/3')).length).toBe(1);
    expect(warnMessages.filter((m) => m.includes('auto-retry 2/3')).length).toBe(1);
    expect(warnMessages.filter((m) => m.includes('auto-retry 3/3')).length).toBe(1);
  });

  test('Go back takes the back-nav path even with an auto-retry pending, and does not recycle', async () => {
    shouldThrow = true;
    const { provider } = makeFakeProvider(true);
    const onRecycle = vi.fn((_docName: string) => {});
    const onNavigateBack = vi.fn((_previousDocName: string) => {});
    const invalidateSpy = vi
      .spyOn(syncPromiseModule, 'invalidateSyncPromise')
      .mockImplementation(() => {});

    render(
      <DocumentErrorBoundary
        activeDocName="alpha.md"
        previousDocName="beta.md"
        onNavigateBack={onNavigateBack}
        onRecycle={onRecycle}
        provider={provider}
      >
        <ThrowSyncTimeout docName="alpha.md" />
      </DocumentErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /go back/i }));

    expect(onNavigateBack).toHaveBeenCalledTimes(1);
    expect(onNavigateBack.mock.calls[0]?.[0]).toBe('beta.md');
    expect(invalidateSpy).toHaveBeenCalledWith('alpha.md');
    expect(warnMessages.some((m) => m.includes('back-nav reset (no recycle)'))).toBe(true);
    expect(onRecycle).not.toHaveBeenCalled();

    invalidateSpy.mockRestore();
  });
});
