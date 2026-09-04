import { act, cleanup, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
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
let panelRenders = 0;
let panelMounts = 0;
let panelUnmounts = 0;
const mockPanelModule = () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  TerminalPanel: (props: any) => {
    panelRenders += 1;
    lastPanelProps = props;
    useEffect(() => {
      panelMounts += 1;
      return () => {
        panelUnmounts += 1;
      };
    }, []);
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

async function resolvePanelPayloadForSyncAssertion() {
  consentState = { enabled: true, synced: true };
  const warmup = renderGate();
  await screen.findByTestId('terminal-panel');
  warmup.unmount();
  panelRenders = 0;
  panelMounts = 0;
  panelUnmounts = 0;
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
    panelRenders = 0;
    panelMounts = 0;
    panelUnmounts = 0;
  });
  afterEach(() => {
    cleanup();
    vi.doUnmock('@/lib/lazy-with-preload');
    vi.doMock('./TerminalPanel', mockPanelModule);
    vi.resetModules();
  });

  test('default (enabled === null) mounts the terminal — available with no dialog', async () => {
    consentState = { enabled: null, synced: true };
    renderGate();
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
    expect(lastPanelProps?.onTitleChange).toBe(onTitleChange);
    expect(lastPanelProps?.launch).toBe(launch);
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

  test('does not flash the shell before the binding syncs (cold start)', async () => {
    await resolvePanelPayloadForSyncAssertion();
    consentState = { enabled: null, synced: false };
    renderGate();
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
    expect(notice()).toBeNull();
  });

  test('mounts directly when the first project-local consent sync completes', async () => {
    await resolvePanelPayloadForSyncAssertion();

    consentState = { enabled: null, synced: false };
    const view = renderGate();
    expect(screen.queryByTestId('terminal-panel')).toBeNull();

    const rendersBeforeSync = panelRenders;
    consentState = { enabled: true, synced: true };
    view.rerender(<TerminalGate bridge={bridge} />);

    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    expect(panelRenders).toBe(rendersBeforeSync + 2);
    expect(panelMounts).toBe(1);
  });

  test('keeps a mounted terminal alive through a transient config epoch rebuild', async () => {
    consentState = { enabled: true, synced: true };
    const view = renderGate();
    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    expect(panelMounts).toBe(1);

    consentState = { enabled: null, synced: false };
    view.rerender(<TerminalGate bridge={bridge} />);

    expect(screen.getByTestId('terminal-panel')).toBeTruthy();
    expect(panelMounts).toBe(1);
    expect(panelUnmounts).toBe(0);

    consentState = { enabled: true, synced: true };
    view.rerender(<TerminalGate bridge={bridge} />);
    expect(screen.getByTestId('terminal-panel')).toBeTruthy();
    expect(panelMounts).toBe(1);
    expect(panelUnmounts).toBe(0);
  });

  test('retains an explicit opt-out through a transient config epoch rebuild', () => {
    consentState = { enabled: false, synced: true };
    const view = renderGate();
    expect(screen.getByRole('region', { name: 'Terminal disabled' })).toBeTruthy();

    consentState = { enabled: null, synced: false };
    view.rerender(<TerminalGate bridge={bridge} />);

    expect(screen.getByRole('region', { name: 'Terminal disabled' })).toBeTruthy();
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
    expect(panelMounts).toBe(0);
  });

  test('an explicit synced revoke still unmounts a running terminal', async () => {
    consentState = { enabled: true, synced: true };
    const view = renderGate();
    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    const rendersBeforeRevoke = panelRenders;

    consentState = { enabled: false, synced: true };
    view.rerender(<TerminalGate bridge={bridge} />);

    expect(screen.getByRole('region', { name: 'Terminal disabled' })).toBeTruthy();
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
    expect(panelRenders).toBe(rendersBeforeRevoke);
    expect(panelMounts).toBe(1);
    expect(panelUnmounts).toBe(1);
  });

  test('announces that the terminal is starting while the binding syncs (PRD-8313)', async () => {
    await resolvePanelPayloadForSyncAssertion();
    consentState = { enabled: null, synced: false };
    renderGate();
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
    expect(screen.getByTestId('terminal-starting-notice')).toBeTruthy();
  });

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
    const { FreshGate, preload } = await importGateWithPreloadSpy();

    consentState = { enabled: null, synced: false };
    render(<FreshGate bridge={bridge} />);

    expect(preload).toHaveBeenCalledTimes(1);
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
