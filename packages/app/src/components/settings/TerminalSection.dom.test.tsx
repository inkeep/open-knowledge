/**
 * Behavioral tests for the Settings → Terminal section: the per-project shell
 * opt-out toggle and the per-machine "auto-approve OpenKnowledge tools" toggle.
 *
 * The system boundaries (the CRDT-backed consent hook, the user ConfigBinding)
 * are mocked; the real shadcn Switch is rendered. Two switches now exist, so
 * every query is scoped by test id.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

type ConsentState = { enabled: boolean | null; synced: boolean };
type Writer = ((enabled: boolean) => { ok: true } | { ok: false; error: string }) | null;

let consentState: ConsentState = { enabled: false, synced: true };
let writerImpl: Writer = null;
const writerCalls: boolean[] = [];

let userConfig: { agents?: { autoApproveOkTools?: boolean } } | null = {
  agents: { autoApproveOkTools: true },
};
let userSynced = true;
let userBinding: { patch: (p: unknown) => { ok: true } | { ok: false; error: unknown } } | null = {
  patch: () => ({ ok: true }),
};
const userPatchCalls: unknown[] = [];

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((out, part, index) => `${out}${part}${values[index] ?? ''}`, ''),
  }),
}));

mock.module('sonner', () => ({
  toast: { error: () => {} },
}));

mock.module('@/hooks/use-terminal-enabled', () => ({
  useTerminalConsentState: () => consentState,
  useTerminalEnabledWriter: () => writerImpl,
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({ userConfig, userSynced, userBinding }),
}));

const { TerminalSection } = await import('./TerminalSection');

function shellSwitch(): HTMLButtonElement {
  return screen.getByTestId('settings-terminal-toggle') as HTMLButtonElement;
}
function autoApproveSwitch(): HTMLButtonElement {
  return screen.getByTestId('settings-terminal-autoapprove-toggle') as HTMLButtonElement;
}

describe('TerminalSection (Settings opt-out toggle)', () => {
  beforeEach(() => {
    consentState = { enabled: false, synced: true };
    writerImpl = (enabled) => {
      writerCalls.push(enabled);
      return { ok: true };
    };
    writerCalls.length = 0;
    userConfig = { agents: { autoApproveOkTools: true } };
    userSynced = true;
    userBinding = {
      patch: (p) => {
        userPatchCalls.push(p);
        return { ok: true };
      },
    };
    userPatchCalls.length = 0;
  });
  afterEach(() => cleanup());

  test('the default (never-chosen) state reads as on', () => {
    consentState = { enabled: null, synced: true };
    render(<TerminalSection />);
    expect(shellSwitch().getAttribute('aria-checked')).toBe('true');
  });

  test('the granted state reads as on', () => {
    consentState = { enabled: true, synced: true };
    render(<TerminalSection />);
    expect(shellSwitch().getAttribute('aria-checked')).toBe('true');
  });

  test('an explicit opt-out reads as off', () => {
    consentState = { enabled: false, synced: true };
    render(<TerminalSection />);
    expect(shellSwitch().getAttribute('aria-checked')).toBe('false');
  });

  test('on → off opts out immediately via writer(false)', async () => {
    consentState = { enabled: true, synced: true };
    render(<TerminalSection />);
    await userEvent.click(shellSwitch());
    expect(writerCalls).toEqual([false]);
  });

  test('off → on re-enables directly via writer(true), no dialog', async () => {
    consentState = { enabled: false, synced: true };
    render(<TerminalSection />);
    await userEvent.click(shellSwitch());
    expect(writerCalls).toEqual([true]);
  });

  test('the toggle is disabled until the project-local binding is ready', () => {
    consentState = { enabled: null, synced: false };
    writerImpl = null;
    render(<TerminalSection />);
    expect(shellSwitch().disabled).toBe(true);
  });
});

describe('TerminalSection (auto-approve OpenKnowledge tools toggle)', () => {
  beforeEach(() => {
    consentState = { enabled: true, synced: true };
    writerImpl = () => ({ ok: true });
    userConfig = { agents: { autoApproveOkTools: true } };
    userSynced = true;
    userBinding = {
      patch: (p) => {
        userPatchCalls.push(p);
        return { ok: true };
      },
    };
    userPatchCalls.length = 0;
  });
  afterEach(() => cleanup());

  test('default (unset) reads as on', () => {
    userConfig = { agents: {} };
    render(<TerminalSection />);
    expect(autoApproveSwitch().getAttribute('aria-checked')).toBe('true');
  });

  test('an explicit false reads as off', () => {
    userConfig = { agents: { autoApproveOkTools: false } };
    render(<TerminalSection />);
    expect(autoApproveSwitch().getAttribute('aria-checked')).toBe('false');
  });

  test('toggling writes the user-scope leaf via the user binding', async () => {
    userConfig = { agents: { autoApproveOkTools: true } };
    render(<TerminalSection />);
    await userEvent.click(autoApproveSwitch());
    expect(userPatchCalls).toEqual([{ agents: { autoApproveOkTools: false } }]);
  });

  test('is disabled until the user binding is ready', () => {
    userSynced = false;
    userBinding = null;
    render(<TerminalSection />);
    expect(autoApproveSwitch().disabled).toBe(true);
  });
});

/**
 * The codex-can't-honor signal. Codex only receives the `-c` auto-approve
 * override once OK's server entry exists in its config; without the note, a user
 * who turns the toggle on watches codex prompt anyway with no explanation.
 */
type CodexReadiness = { onPath: string; okServerConfigured?: boolean };

function stubDesktopBridge(readiness: CodexReadiness | Error): void {
  (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {
    terminal: {
      cliPreflight: async () =>
        readiness instanceof Error ? Promise.reject(readiness) : readiness,
    },
  };
}

function codexNote(): HTMLElement | null {
  return screen.queryByTestId('settings-terminal-autoapprove-codex-note');
}

describe("TerminalSection (codex-can't-honor note)", () => {
  beforeEach(() => {
    consentState = { enabled: true, synced: true };
    writerImpl = () => ({ ok: true });
    userConfig = { agents: { autoApproveOkTools: true } };
    userSynced = true;
    userBinding = { patch: () => ({ ok: true }) };
  });
  afterEach(() => {
    cleanup();
    (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = undefined;
  });

  test('shows the note when codex is installed but OK is not configured for it', async () => {
    stubDesktopBridge({ onPath: 'present', okServerConfigured: false });
    render(<TerminalSection />);
    await waitFor(() => expect(codexNote()).not.toBeNull());
  });

  test('stays silent when codex already has OK configured', async () => {
    stubDesktopBridge({ onPath: 'present', okServerConfigured: true });
    render(<TerminalSection />);
    await waitFor(() => expect(autoApproveSwitch()).not.toBeNull());
    expect(codexNote()).toBeNull();
  });

  test('stays silent when codex is not installed', async () => {
    stubDesktopBridge({ onPath: 'not-found' });
    render(<TerminalSection />);
    await waitFor(() => expect(autoApproveSwitch()).not.toBeNull());
    expect(codexNote()).toBeNull();
  });

  test('stays silent when the auto-approve toggle is off (nothing to explain)', async () => {
    userConfig = { agents: { autoApproveOkTools: false } };
    stubDesktopBridge({ onPath: 'present', okServerConfigured: false });
    render(<TerminalSection />);
    await waitFor(() => expect(autoApproveSwitch()).not.toBeNull());
    expect(codexNote()).toBeNull();
  });

  test('a failed preflight probe stays silent rather than warning about a CLI the user may not have', async () => {
    stubDesktopBridge(new Error('ipc down'));
    render(<TerminalSection />);
    await waitFor(() => expect(autoApproveSwitch()).not.toBeNull());
    expect(codexNote()).toBeNull();
  });

  test('the web build (no desktop bridge) never probes', async () => {
    render(<TerminalSection />);
    await waitFor(() => expect(autoApproveSwitch()).not.toBeNull());
    expect(codexNote()).toBeNull();
  });
});
