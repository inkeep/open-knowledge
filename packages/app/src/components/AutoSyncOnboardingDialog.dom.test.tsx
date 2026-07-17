import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

type SyncWriter = (enabled: boolean) => { ok: true } | { ok: false; error: string };

let writer: SyncWriter | null = null;
const toastErrors: string[] = [];

import * as actualLinguiMacro from '@lingui/react/macro';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((out, part, index) => `${out}${part}${values[index] ?? ''}`, ''),
  }),
}));

mock.module('sonner', () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
}));

mock.module('@/hooks/use-enable-sync-with-confirm', () => ({
  useSyncEnabledWriter: () => writer,
}));

async function renderDialog(onResolved: () => void = () => {}) {
  const { AutoSyncOnboardingDialog } = await import('./AutoSyncOnboardingDialog');
  render(<AutoSyncOnboardingDialog open={true} onResolved={onResolved} />);
}

describe('AutoSyncOnboardingDialog runtime behavior', () => {
  afterEach(() => {
    cleanup();
    writer = null;
    toastErrors.length = 0;
  });

  test('exports the component', async () => {
    const mod = await import('./AutoSyncOnboardingDialog');
    expect(typeof mod.AutoSyncOnboardingDialog).toBe('function');
  });

  test('renders stable primary and secondary choices without a close affordance', async () => {
    writer = () => ({ ok: true });
    await renderDialog();

    expect(screen.getByRole('button', { name: 'Enable auto-sync' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Keep disabled' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('Heads up');
  });

  test('disables both choices until the project-local sync writer is ready', async () => {
    writer = null;
    await renderDialog();

    expect(
      (screen.getByRole('button', { name: 'Enable auto-sync' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Keep disabled' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test('persists enable and disable choices through the shared writer', async () => {
    const writerCalls: boolean[] = [];
    const resolvedCalls: string[] = [];
    writer = (enabled) => {
      writerCalls.push(enabled);
      return { ok: true };
    };
    await renderDialog(() => resolvedCalls.push('resolved'));

    await userEvent.click(screen.getByRole('button', { name: 'Enable auto-sync' }));
    expect(writerCalls).toEqual([true]);
    expect(resolvedCalls).toEqual(['resolved']);

    cleanup();
    writerCalls.length = 0;
    resolvedCalls.length = 0;
    await renderDialog(() => resolvedCalls.push('resolved'));
    await userEvent.click(screen.getByRole('button', { name: 'Keep disabled' }));

    expect(writerCalls).toEqual([false]);
    expect(resolvedCalls).toEqual(['resolved']);
  });

  test('surfaces writer failures without resolving the dialog', async () => {
    const resolvedCalls: string[] = [];
    writer = () => ({ ok: false, error: 'binding unavailable' });
    await renderDialog(() => resolvedCalls.push('resolved'));

    await userEvent.click(screen.getByRole('button', { name: 'Enable auto-sync' }));

    expect(resolvedCalls).toEqual([]);
    expect(toastErrors).toEqual(['Could not enable sync: binding unavailable']);
  });

  test('Escape does not resolve the non-dismissible prompt', async () => {
    const resolvedCalls: string[] = [];
    writer = () => ({ ok: true });
    await renderDialog(() => resolvedCalls.push('resolved'));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enable auto-sync' })).not.toBeNull();
    });
    expect(resolvedCalls).toEqual([]);
  });
});
