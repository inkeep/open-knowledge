import type { HocuspocusProvider } from '@hocuspocus/provider';
import { bindFrontmatterDoc } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { type Tracer, trace } from '@opentelemetry/api';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkSlidesOpenResult, OkSlidesStatusResult } from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

const { toastDismissSpy, toastErrorSpy, toastLoadingSpy } = vi.hoisted(() => ({
  toastDismissSpy: vi.fn(),
  toastErrorSpy: vi.fn(),
  toastLoadingSpy: vi.fn(() => 'slides-opening'),
}));
vi.mock('sonner', () => ({
  toast: {
    dismiss: toastDismissSpy,
    error: toastErrorSpy,
    info: vi.fn(),
    loading: toastLoadingSpy,
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

interface FakeProvider {
  document: Y.Doc;
  on(event: 'synced', listener: () => void): void;
  off(event: 'synced', listener: () => void): void;
}

function makeProvider(initial = ''): FakeProvider {
  const document = new Y.Doc();
  if (initial) document.getText('source').insert(0, initial);
  const handlers = new Set<() => void>();
  return {
    document,
    on(event, listener) {
      if (event === 'synced') handlers.add(listener);
    },
    off(event, listener) {
      if (event === 'synced') handlers.delete(listener);
    },
  };
}

function patchSlides(provider: FakeProvider, value: boolean | string | null): void {
  const writer = bindFrontmatterDoc(provider);
  writer.patch({ slides: value });
  writer.dispose();
}

function installBridge(opts: {
  status: () => Promise<OkSlidesStatusResult>;
  open?: (docPath: string) => Promise<OkSlidesOpenResult>;
  projectPath?: string;
  platform?: string;
}) {
  const statusSpy = vi.fn(opts.status);
  const openSpy = vi.fn(
    opts.open ?? (() => Promise.resolve({ kind: 'open', ok: true }) as Promise<OkSlidesOpenResult>),
  );
  (window as unknown as { okDesktop?: unknown }).okDesktop = {
    config: { projectPath: opts.projectPath ?? '/proj' },
    platform: opts.platform ?? 'darwin',
    slides: { status: statusSpy, open: openSpy },
  };
  return { statusSpy, openSpy };
}

async function renderControls(provider: FakeProvider, docName = 'talks/Deck') {
  const { SlidesToolbarControls } = await import('./SlidesToolbarControls');
  return render(
    <TooltipProvider>
      <SlidesToolbarControls
        provider={provider as unknown as HocuspocusProvider}
        docName={docName}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  vi.clearAllMocks();
});

describe('SlidesToolbarControls — visibility', () => {
  test('a deck whose slidev resolves shows the Slidev action', async () => {
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));
    expect(await screen.findByTestId('slides-toolbar-action')).toBeTruthy();
  });

  test('the icon-only action carries an accessible name', async () => {
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));
    expect(await screen.findByRole('button', { name: 'Open in Slidev' })).toBeTruthy();
  });

  test('a deck with no resolvable slidev shows no action', async () => {
    const { statusSpy } = installBridge({
      status: () => Promise.resolve({ kind: 'status', available: false }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('slides-toolbar-action')).toBeNull();
  });

  test('a status probe that rejects hides the action and logs the fault', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { statusSpy } = installBridge({
      status: () => Promise.reject(new Error('bridge broke')),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('slides-toolbar-action')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[slides] availability probe failed:', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('a non-deck document shows no action and never probes slidev', async () => {
    const { statusSpy } = installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
    });
    await renderControls(makeProvider('---\ntitle: Notes\n---\nbody\n'));
    await Promise.resolve();
    expect(screen.queryByTestId('slides-toolbar-action')).toBeNull();
    expect(statusSpy).not.toHaveBeenCalled();
  });

  test('adding slides: true reveals the action without remount', async () => {
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
    });
    const provider = makeProvider('---\ntitle: Notes\n---\nbody\n');
    await renderControls(provider);
    expect(screen.queryByTestId('slides-toolbar-action')).toBeNull();

    act(() => patchSlides(provider, true));

    expect(await screen.findByTestId('slides-toolbar-action')).toBeTruthy();
  });

  test('a mid-session install reveals the action on window focus, without remount', async () => {
    let available = false;
    const { statusSpy } = installBridge({
      status: () =>
        Promise.resolve(
          available
            ? ({ kind: 'status', available: true, source: 'global' } as OkSlidesStatusResult)
            : ({ kind: 'status', available: false } as OkSlidesStatusResult),
        ),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('slides-toolbar-action')).toBeNull();

    available = true;
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 60_000);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByTestId('slides-toolbar-action')).toBeTruthy();
    nowSpy.mockRestore();
    expect(statusSpy).toHaveBeenCalledTimes(2);
  });

  test('stops re-probing on focus once slidev has resolved available', async () => {
    const { statusSpy } = installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));
    expect(await screen.findByTestId('slides-toolbar-action')).toBeTruthy();
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(statusSpy).toHaveBeenCalledTimes(1);
  });
});

describe('SlidesToolbarControls — activation', () => {
  test('activating the action opens the deck at its absolute path', async () => {
    const user = userEvent.setup();
    const { openSpy } = installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'project-local' }),
      projectPath: '/proj',
      platform: 'darwin',
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'), 'talks/Deck');

    await user.click(await screen.findByTestId('slides-toolbar-action'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('/proj/talks/Deck.md'));
  });

  test('one in-flight open reports busy progress and suppresses duplicate activation', async () => {
    const spanNames: string[] = [];
    const getTracerSpy = vi.spyOn(trace, 'getTracer').mockImplementation(
      () =>
        ({
          startSpan: (name: string) => {
            spanNames.push(name);
            return { end: () => undefined };
          },
        }) as unknown as Tracer,
    );
    try {
      const user = userEvent.setup();
      let resolveOpen: ((result: OkSlidesOpenResult) => void) | undefined;
      const pendingOpen = new Promise<OkSlidesOpenResult>((resolve) => {
        resolveOpen = resolve;
      });
      const { openSpy } = installBridge({
        status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
        open: () => pendingOpen,
      });
      await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

      const action = await screen.findByTestId('slides-toolbar-action');
      await user.click(action);
      await user.click(action);

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(spanNames.filter((name) => name === 'ok.slides.opened')).toHaveLength(1);
      expect(action.getAttribute('aria-busy')).toBe('true');
      expect(toastLoadingSpy).toHaveBeenCalledWith('Opening...', {
        duration: Number.POSITIVE_INFINITY,
      });

      resolveOpen?.({ kind: 'open', ok: true });
      await waitFor(() => expect(action.getAttribute('aria-busy')).toBe('false'));
      expect(toastDismissSpy).toHaveBeenCalledWith('slides-opening');
    } finally {
      getTracerSpy.mockRestore();
    }
  });

  test('a readiness timeout surfaces its own retry-hinting message', async () => {
    const user = userEvent.setup();
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      open: () => Promise.resolve({ kind: 'open', ok: false, reason: 'timeout' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

    await user.click(await screen.findByTestId('slides-toolbar-action'));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        'Slidev timed out while starting. Try again.',
        expect.objectContaining({ id: 'slides-opening' }),
      ),
    );
  });

  test('a deck that crashes Slidev on boot gets a message distinct from a timeout', async () => {
    const user = userEvent.setup();
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      open: () => Promise.resolve({ kind: 'open', ok: false, reason: 'exited-early' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

    await user.click(await screen.findByTestId('slides-toolbar-action'));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Slidev couldn't render this document.",
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Try again' }),
          id: 'slides-opening',
        }),
      ),
    );
  });

  test('retry keeps the failed path without blocking another deck', async () => {
    const spanNames: string[] = [];
    const getTracerSpy = vi.spyOn(trace, 'getTracer').mockImplementation(
      () =>
        ({
          startSpan: (name: string) => {
            spanNames.push(name);
            return { end: () => undefined };
          },
        }) as unknown as Tracer,
    );
    try {
      const user = userEvent.setup();
      const providerA = makeProvider('---\nslides: true\n---\nA\n');
      const providerB = makeProvider('---\nslides: true\n---\nB\n');
      let resolveRetry: ((result: OkSlidesOpenResult) => void) | undefined;
      let resolveDeckB: ((result: OkSlidesOpenResult) => void) | undefined;
      let attempts = 0;
      const { openSpy } = installBridge({
        status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
        open: (docPath) => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.resolve({ kind: 'open', ok: false, reason: 'renderer-failed' });
          }
          return new Promise<OkSlidesOpenResult>((resolve) => {
            if (docPath.endsWith('/A.md')) resolveRetry = resolve;
            else resolveDeckB = resolve;
          });
        },
      });
      const rendered = await renderControls(providerA, 'talks/A');

      await user.click(await screen.findByTestId('slides-toolbar-action'));
      await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledTimes(1));
      const retry = (
        toastErrorSpy.mock.calls[0]?.[1] as { action?: { onClick?: () => void } } | undefined
      )?.action?.onClick;
      expect(retry).toBeTypeOf('function');

      const { SlidesToolbarControls } = await import('./SlidesToolbarControls');
      rendered.rerender(
        <TooltipProvider>
          <SlidesToolbarControls
            provider={providerB as unknown as HocuspocusProvider}
            docName="talks/B"
          />
        </TooltipProvider>,
      );
      act(() => retry?.());

      const action = await screen.findByTestId('slides-toolbar-action');
      expect(action.getAttribute('aria-busy')).toBe('false');
      await user.click(action);

      expect(openSpy).toHaveBeenCalledTimes(3);
      expect(openSpy.mock.calls.map(([docPath]) => docPath)).toEqual([
        '/proj/talks/A.md',
        '/proj/talks/A.md',
        '/proj/talks/B.md',
      ]);
      expect(toastLoadingSpy).toHaveBeenCalledTimes(3);
      expect(spanNames.filter((name) => name === 'ok.slides.opened')).toHaveLength(2);
      expect(action.getAttribute('aria-busy')).toBe('true');

      await act(async () => {
        resolveRetry?.({ kind: 'open', ok: true });
      });
      expect(action.getAttribute('aria-busy')).toBe('true');
      resolveDeckB?.({ kind: 'open', ok: true });
      await waitFor(() => expect(action.getAttribute('aria-busy')).toBe('false'));
    } finally {
      getTracerSpy.mockRestore();
    }
  });

  test('a shell that never renders a deck surfaces the render-failure message', async () => {
    const user = userEvent.setup();
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      open: () => Promise.resolve({ kind: 'open', ok: false, reason: 'renderer-failed' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

    await user.click(await screen.findByTestId('slides-toolbar-action'));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Slidev couldn't render this document.",
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Try again' }),
          id: 'slides-opening',
        }),
      ),
    );
  });

  test('closing the hidden window cancels progress without showing an error', async () => {
    const user = userEvent.setup();
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      open: () => Promise.resolve({ kind: 'open', ok: false, reason: 'cancelled' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

    const action = await screen.findByTestId('slides-toolbar-action');
    await user.click(action);

    await waitFor(() => expect(toastDismissSpy).toHaveBeenCalledWith('slides-opening'));
    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(action.getAttribute('aria-busy')).toBe('false');
  });

  test('a foreign or too-old server on the port surfaces the unsupported-version message', async () => {
    const user = userEvent.setup();
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      open: () => Promise.resolve({ kind: 'open', ok: false, reason: 'unsupported-server' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

    await user.click(await screen.findByTestId('slides-toolbar-action'));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "This isn't a supported version of Slidev.",
        expect.objectContaining({ id: 'slides-opening' }),
      ),
    );
  });

  test('a spawn failure surfaces a message distinct from a hung or crashed boot', async () => {
    const user = userEvent.setup();
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      open: () => Promise.resolve({ kind: 'open', ok: false, reason: 'spawn-error' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

    await user.click(await screen.findByTestId('slides-toolbar-action'));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Couldn't start Slidev.",
        expect.objectContaining({ id: 'slides-opening' }),
      ),
    );
  });

  test('an open that rejects at the IPC boundary surfaces an error and logs the cause', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const user = userEvent.setup();
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      open: () => Promise.reject(new Error('transport failed')),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

    await user.click(await screen.findByTestId('slides-toolbar-action'));

    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledTimes(1));
    expect(warnSpy).toHaveBeenCalledWith('[slides] open dispatch failed:', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('SlidesToolbarControls — focus re-probe is bounded', () => {
  test('rapid window focus does not re-probe on every event', async () => {
    const { statusSpy } = installBridge({
      status: () => Promise.resolve({ kind: 'status', available: false }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));

    act(() => {
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('focus'));
    });

    expect(statusSpy).toHaveBeenCalledTimes(1);
  });
});
