/**
 * Behavioral tests for TerminalGate — the renderer-side enforcement.
 *
 * The system boundaries are mocked: the consent hook (CRDT-backed config) and
 * the PTY-spawning TerminalPanel. The assertions pin the default-on contract:
 * the shell (TerminalPanel) mounts unless the project explicitly opts out
 * (`terminal.enabled === false`); `null`/default and `true` both mount with no
 * dialog; `false` shows the not-enabled notice; the notice re-enables via the
 * writer; the mount is held until the binding syncs so an opted-out project
 * never flashes the shell.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

type ConsentState = { enabled: boolean | null; synced: boolean };
type Writer = ((enabled: boolean) => { ok: true } | { ok: false; error: string }) | null;

let consentState: ConsentState = { enabled: null, synced: true };
let writerImpl: Writer = null;
const writerCalls: boolean[] = [];
const toastErrors: string[] = [];

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((out, part, index) => `${out}${part}${values[index] ?? ''}`, ''),
  }),
}));

vi.doMock('sonner', () => ({
  toast: { error: (message: string) => toastErrors.push(message) },
}));

vi.doMock('@/hooks/use-terminal-enabled', () => ({
  useTerminalConsentState: () => consentState,
  useTerminalEnabledWriter: () => writerImpl,
}));

// biome-ignore lint/suspicious/noExplicitAny: captured mock-component props, asserted structurally
let lastPanelProps: Record<string, any> | null = null;
// Named so the Suspense-fallback test below — which calls vi.resetModules() and
// registers its own deferred ./TerminalPanel stub to get a fresh module graph —
// can put the file-level stub back afterward. Without that restore the registry
// mutation leaks and what a later `import('./TerminalGate')` resolves to depends
// on test order. (The two preload tests reset the registry too, but they replace
// `@/lib/lazy-with-preload` rather than this module.)
const mockPanelModule = () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  TerminalPanel: (props: any) => {
    lastPanelProps = props;
    return <span data-testid="terminal-panel" />;
  },
});
vi.doMock('./TerminalPanel', mockPanelModule);

const { TerminalGate } = await import('./TerminalGate');

const bridge = {} as OkDesktopBridge;

function renderGate() {
  return render(<TerminalGate bridge={bridge} />);
}

function notice() {
  return screen.queryByRole('region', { name: 'Terminal disabled' });
}

describe('TerminalGate', () => {
  beforeEach(() => {
    consentState = { enabled: null, synced: true };
    writerImpl = (enabled) => {
      writerCalls.push(enabled);
      return { ok: true };
    };
    writerCalls.length = 0;
    toastErrors.length = 0;
    lastPanelProps = null;
  });
  afterEach(() => {
    cleanup();
    // Restore what the module-registry tests replaced, so nothing here is
    // order-dependent: the file-level panel stub, and the real lazy-with-preload
    // that the two preload tests swap for a spy.
    vi.doUnmock('@/lib/lazy-with-preload');
    vi.doMock('./TerminalPanel', mockPanelModule);
    vi.resetModules();
  });

  test('default (enabled === null) mounts the terminal — available with no dialog', async () => {
    consentState = { enabled: null, synced: true };
    renderGate();
    // TerminalPanel is React.lazy (keeps xterm out of the initial/web bundle),
    // so it resolves through Suspense on a microtask rather than synchronously.
    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    expect(notice()).toBeNull();
  });

  test('forwards onClose, onTitleChange, launch, onPtyId, and adoptPtyId to the mounted terminal panel', async () => {
    const onClose = vi.fn(() => {});
    const onTitleChange = vi.fn((_title: string) => {});
    const onPtyId = vi.fn((_ptyId: string | null) => {});
    const launch = { prompt: 'work on docs/notes', nonce: 1 };
    consentState = { enabled: null, synced: true };
    render(
      <TerminalGate
        bridge={bridge}
        onClose={onClose}
        onTitleChange={onTitleChange}
        launch={launch}
        onPtyId={onPtyId}
        adoptPtyId="pty-survivor"
      />,
    );
    await screen.findByTestId('terminal-panel');
    expect(lastPanelProps?.onClose).toBe(onClose);
    // onTitleChange forwarding is the single point of failure for the tab-title
    // feature at the gate layer: TerminalPanel tests wire it directly and Dock
    // tests stub the gate, so a dropped forward would otherwise pass every test.
    expect(lastPanelProps?.onTitleChange).toBe(onTitleChange);
    // launch is the sole carrier of the "Open in terminal" one-shot prompt — a
    // refactor dropping launch={launch} would otherwise pass every gate test.
    expect(lastPanelProps?.launch).toBe(launch);
    // onPtyId + adoptPtyId are the reuse/reload-survival wires: the gate is the
    // only place they cross from host to panel, and every Dock/reload test stubs
    // the gate, so a dropped forward here would silently break reuse and survivor
    // adoption while passing all of those.
    expect(lastPanelProps?.onPtyId).toBe(onPtyId);
    expect(lastPanelProps?.adoptPtyId).toBe('pty-survivor');
  });

  test('enabled === true mounts the terminal', async () => {
    consentState = { enabled: true, synced: true };
    renderGate();
    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    expect(notice()).toBeNull();
  });

  test('enabled === false shows the not-enabled notice; no shell', () => {
    consentState = { enabled: false, synced: true };
    renderGate();
    expect(screen.getByRole('region', { name: 'Terminal disabled' })).toBeTruthy();
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
  });

  test('does not flash the shell before the binding syncs (cold start)', () => {
    // Pre-sync the leaf reads as the cold-start null; mounting now would spawn a
    // PTY the main backstop refuses if the project turns out to be opted out.
    consentState = { enabled: null, synced: false };
    renderGate();
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
    expect(notice()).toBeNull();
  });

  test('announces that the terminal is starting while the binding syncs (PRD-8313)', () => {
    // Holding the mount is right; rendering nothing while we hold it is not. A
    // featureless pane is indistinguishable from "the keystroke did nothing", so
    // a user whose cold start runs long re-invokes and stacks up tabs. The pane
    // must say a shell is coming for as long as it withholds one.
    consentState = { enabled: null, synced: false };
    renderGate();
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
    expect(screen.getByTestId('terminal-starting-notice')).toBeTruthy();
  });

  // Both preload tests spy on `.preload()` rather than counting module-factory
  // invocations. The opt-out case is a NEGATIVE assertion, so it needs a
  // synchronous observation point — effects flush inside `render`'s `act`, and
  // there is no settle window to await — and the spy gives both tests the same
  // mechanism. It also removes a dependency on vitest resolving a
  // freshly-registered module on its own schedule, which the earlier counting
  // version had to poll for and which was observed timing out. The
  // Suspense-fallback test below crosses that same boundary safely because it
  // OWNS the resolution: it awaits a promise the test itself releases.
  //
  // The spy resolves like the real `preload` (`Promise<{ default }>`) even
  // though the call site discards it, so adding a `.catch()` there later does
  // not surface as a TypeError thrown inside a passive effect.
  async function importGateWithPreloadSpy() {
    vi.resetModules();
    const preload = vi.fn(() => Promise.resolve({ default: () => null }));
    vi.doMock('@/lib/lazy-with-preload', () => ({
      lazyWithPreload: () =>
        Object.assign(() => <span data-testid="terminal-panel" />, { preload }),
    }));
    const { TerminalGate: FreshGate } = await import('./TerminalGate');
    return { FreshGate, preload };
  }

  test('warms the panel chunk while the binding is still syncing (PRD-8313)', async () => {
    // The preload is the one part of this change that alters TIMING rather than
    // rendering, so it is the part a later "this looks redundant" cleanup can
    // silently undo.
    const { FreshGate, preload } = await importGateWithPreloadSpy();

    consentState = { enabled: null, synced: false };
    render(<FreshGate bridge={bridge} />);

    expect(preload).toHaveBeenCalledTimes(1);
    // Warming the chunk must not weaken what the gate withholds: no PTY-spawning
    // panel is mounted while the binding is unsynced.
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
    expect(screen.getByTestId('terminal-starting-notice')).toBeTruthy();
  });

  test('does not warm the panel chunk for a project that opted out (PRD-8313)', async () => {
    const { FreshGate, preload } = await importGateWithPreloadSpy();

    consentState = { enabled: false, synced: true };
    render(<FreshGate bridge={bridge} />);

    expect(screen.getByRole('region', { name: 'Terminal disabled' })).toBeTruthy();
    expect(preload).not.toHaveBeenCalled();
  });

  test('the lazy-chunk Suspense fallback shows the same starting notice (PRD-8313)', async () => {
    // The other pre-mount branch. It is only reachable in a module graph where
    // `lazy()` has not already resolved TerminalPanel — once loaded it never
    // suspends again — so this test builds a fresh graph whose panel module
    // stays pending until we release it.
    vi.resetModules();
    let releasePanel: () => void = () => {};
    const panelGate = new Promise<void>((resolve) => {
      releasePanel = resolve;
    });
    vi.doMock('./TerminalPanel', async () => {
      await panelGate;
      return { TerminalPanel: () => <span data-testid="terminal-panel" /> };
    });
    const { TerminalGate: FreshGate } = await import('./TerminalGate');

    consentState = { enabled: null, synced: true };
    render(<FreshGate bridge={bridge} />);

    // Synced, so the gate is open and the shell is wanted — but the chunk has
    // not arrived, which is stage 2 of the cold start.
    expect(screen.getByTestId('terminal-starting-notice')).toBeTruthy();
    expect(screen.queryByTestId('terminal-panel')).toBeNull();

    releasePanel();
    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    expect(screen.queryByTestId('terminal-starting-notice')).toBeNull();
  });

  test('re-enabling from the notice grants via the writer, then mounts the terminal', async () => {
    consentState = { enabled: false, synced: true };
    const view = render(<TerminalGate bridge={bridge} />);
    act(() => screen.getByRole('button', { name: 'Enable terminal' }).click());
    expect(writerCalls).toEqual([true]);
    // The writer flips the project-local config; once that grant syncs back, the
    // gate must leave the opt-out notice and mount the shell (otherwise a
    // regression that never transitions out of the notice would pass).
    consentState = { enabled: true, synced: true };
    view.rerender(<TerminalGate bridge={bridge} />);
    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    expect(notice()).toBeNull();
  });

  test('re-enable with no writer yet surfaces an actionable toast, no crash', () => {
    consentState = { enabled: false, synced: true };
    writerImpl = null;
    renderGate();
    act(() => screen.getByRole('button', { name: 'Enable terminal' }).click());
    expect(writerCalls).toEqual([]);
    expect(toastErrors.length).toBe(1);
  });

  test('a writer that fails to persist surfaces a toast and never mounts the shell', () => {
    consentState = { enabled: false, synced: true };
    writerImpl = (enabled) => {
      writerCalls.push(enabled);
      return { ok: false, error: 'ENOSPC: no space left on device' };
    };
    renderGate();
    act(() => screen.getByRole('button', { name: 'Enable terminal' }).click());

    expect(writerCalls).toEqual([true]);
    expect(toastErrors.length).toBe(1);
    expect(toastErrors[0]).toContain('ENOSPC');
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
  });
});
