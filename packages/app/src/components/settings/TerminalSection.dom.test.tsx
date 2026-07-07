/**
 * Behavioral tests for the Settings → Terminal opt-out toggle.
 *
 * The system boundary (the CRDT-backed consent hook) is mocked; the real shadcn
 * Switch is rendered. Assertions pin the default-on opt-out: the default
 * (never-chosen) and granted states read as on; only an explicit `false` reads
 * as off; on → off writes `false`; off → on writes `true` directly (no consent
 * dialog); the control is disabled until the binding is ready.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

type ConsentState = { enabled: boolean | null; synced: boolean };
type Writer = ((enabled: boolean) => { ok: true } | { ok: false; error: string }) | null;

let consentState: ConsentState = { enabled: false, synced: true };
let writerImpl: Writer = null;
const writerCalls: boolean[] = [];

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

const { TerminalSection } = await import('./TerminalSection');

function switchChecked(): string | null {
  return (screen.getByRole('switch') as HTMLButtonElement).getAttribute('aria-checked');
}

describe('TerminalSection (Settings opt-out toggle)', () => {
  beforeEach(() => {
    consentState = { enabled: false, synced: true };
    writerImpl = (enabled) => {
      writerCalls.push(enabled);
      return { ok: true };
    };
    writerCalls.length = 0;
  });
  afterEach(() => cleanup());

  test('the default (never-chosen) state reads as on', () => {
    consentState = { enabled: null, synced: true };
    render(<TerminalSection />);
    expect(switchChecked()).toBe('true');
  });

  test('the granted state reads as on', () => {
    consentState = { enabled: true, synced: true };
    render(<TerminalSection />);
    expect(switchChecked()).toBe('true');
  });

  test('an explicit opt-out reads as off', () => {
    consentState = { enabled: false, synced: true };
    render(<TerminalSection />);
    expect(switchChecked()).toBe('false');
  });

  test('on → off opts out immediately via writer(false)', async () => {
    consentState = { enabled: true, synced: true };
    render(<TerminalSection />);
    await userEvent.click(screen.getByRole('switch'));
    expect(writerCalls).toEqual([false]);
  });

  test('off → on re-enables directly via writer(true), no dialog', async () => {
    consentState = { enabled: false, synced: true };
    render(<TerminalSection />);
    await userEvent.click(screen.getByRole('switch'));
    expect(writerCalls).toEqual([true]);
  });

  test('the toggle is disabled until the project-local binding is ready', () => {
    consentState = { enabled: null, synced: false };
    writerImpl = null;
    render(<TerminalSection />);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  });
});
