/**
 * DOM tests for the lazy Slides toolbar action. The component is mounted past
 * its cheap host gate, so these cover the two conditions it owns — the doc
 * declares `slides: true`, and `slidev` resolved — plus activation and the
 * failure surface.
 *
 * The provider is a fake wrapping a real `Y.Doc` (so the frontmatter flag runs
 * through the real `bindFrontmatterDoc` parse), and `window.okDesktop.slides` is
 * a stub — the IPC boundary is the one system boundary these tests fake.
 */

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

const { toastErrorSpy } = vi.hoisted(() => ({ toastErrorSpy: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { error: toastErrorSpy, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
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

/** Mutate the shared frontmatter the way a property-panel edit would, so the
 *  hook's own observer fires. */
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
    // The control renders an icon with no visible text, so assistive tech has
    // only the accessible name to go on — query by role+name, not by testid.
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
    // A rejected probe degrades to "unavailable" (action hidden), never a crash.
    expect(screen.queryByTestId('slides-toolbar-action')).toBeNull();
    // …and is logged with the rejection, so a broken bridge is distinguishable
    // from "not installed" — a content match, not bare existence (which an
    // ambient warn could satisfy).
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
    // The first-run path: open a deck before slidev is installed (no action),
    // install it in a terminal, switch back. That switch is the focus event —
    // the toolbar re-probes and the action appears without reopening the doc.
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
    // Focus re-probes are throttled so a never-installed slidev cannot spawn a
    // login shell on every alt-tab. Installing takes far longer than that
    // window, so advance the clock rather than firing focus instantly — the
    // real path this covers is minutes long, not milliseconds.
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
    // Each status() runs a login-shell PATH probe for a global install, and a
    // resolvable slidev rarely disappears mid-session — so once found, further
    // window-focus events must not spawn another probe.
    const { statusSpy } = installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));
    // Awaiting the action guarantees the resolving probe's `.then` ran — which is
    // where the focus listener unsubscribes.
    expect(await screen.findByTestId('slides-toolbar-action')).toBeTruthy();
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // Still 1: the focus listener was removed once availability resolved.
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

  test('activating the action emits the ok.slides.opened marker', async () => {
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
      installBridge({
        status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      });
      await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

      await user.click(await screen.findByTestId('slides-toolbar-action'));

      await waitFor(() => expect(spanNames).toContain('ok.slides.opened'));
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
      expect(toastErrorSpy).toHaveBeenCalledWith('Slidev timed out while starting. Try again.'),
    );
  });

  test('a deck that crashes Slidev on boot gets a message distinct from a timeout', async () => {
    // The discriminated reason drives distinct, actionable copy: a crashed boot
    // (exited-early) is not the same problem as a hung boot (timeout).
    const user = userEvent.setup();
    installBridge({
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      open: () => Promise.resolve({ kind: 'open', ok: false, reason: 'exited-early' }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));

    await user.click(await screen.findByTestId('slides-toolbar-action'));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith("Slidev couldn't render this document."),
    );
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
      expect(toastErrorSpy).toHaveBeenCalledWith("This isn't a supported version of Slidev."),
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

    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledWith("Couldn't start Slidev."));
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
    // …and the rejection is logged, so a broken bridge stays distinguishable in
    // diagnostics from a returned not-ok result — both surface the same toast.
    expect(warnSpy).toHaveBeenCalledWith('[slides] open dispatch failed:', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('SlidesToolbarControls — focus re-probe is bounded', () => {
  test('rapid window focus does not re-probe on every event', async () => {
    // Each status() runs a login-shell PATH probe on the desktop side. A deck
    // open with slidev absent keeps the focus listener attached, so without a
    // throttle every alt-tab would spawn a shell, indefinitely.
    const { statusSpy } = installBridge({
      status: () => Promise.resolve({ kind: 'status', available: false }),
    });
    await renderControls(makeProvider('---\nslides: true\n---\nbody\n'));
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));

    act(() => {
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('focus'));
    });

    // Still just the mount probe — twenty focus events, no extra shells.
    expect(statusSpy).toHaveBeenCalledTimes(1);
  });
});
