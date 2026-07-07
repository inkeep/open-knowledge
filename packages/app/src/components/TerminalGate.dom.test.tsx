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
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

type ConsentState = { enabled: boolean | null; synced: boolean };
type Writer = ((enabled: boolean) => { ok: true } | { ok: false; error: string }) | null;

let consentState: ConsentState = { enabled: null, synced: true };
let writerImpl: Writer = null;
const writerCalls: boolean[] = [];
const toastErrors: string[] = [];

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((out, part, index) => `${out}${part}${values[index] ?? ''}`, ''),
  }),
}));

mock.module('sonner', () => ({
  toast: { error: (message: string) => toastErrors.push(message) },
}));

mock.module('@/hooks/use-terminal-enabled', () => ({
  useTerminalConsentState: () => consentState,
  useTerminalEnabledWriter: () => writerImpl,
}));

// biome-ignore lint/suspicious/noExplicitAny: captured mock-component props, asserted structurally
let lastPanelProps: Record<string, any> | null = null;
mock.module('./TerminalPanel', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  TerminalPanel: (props: any) => {
    lastPanelProps = props;
    return <span data-testid="terminal-panel" />;
  },
}));

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
  afterEach(() => cleanup());

  test('default (enabled === null) mounts the terminal — available with no dialog', async () => {
    consentState = { enabled: null, synced: true };
    renderGate();
    // TerminalPanel is React.lazy (keeps xterm out of the initial/web bundle),
    // so it resolves through Suspense on a microtask rather than synchronously.
    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    expect(notice()).toBeNull();
  });

  test('forwards onClose, onTitleChange, launch, onPtyId, and adoptPtyId to the mounted terminal panel', async () => {
    const onClose = mock(() => {});
    const onTitleChange = mock((_title: string) => {});
    const onPtyId = mock((_ptyId: string | null) => {});
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
