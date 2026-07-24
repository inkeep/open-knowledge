import type { SyncMode } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AutoSyncOnboardingVariant } from './auto-sync-onboarding-gate.ts';

type ModeWriter = (mode: SyncMode) => { ok: true } | { ok: false; error: string };

let writer: ModeWriter | null = null;
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
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
}));

vi.doMock('@/hooks/use-enable-sync-with-confirm', () => ({
  useSyncModeWriter: () => writer,
}));

async function renderDialog(
  variant: AutoSyncOnboardingVariant = 'full',
  onResolved: () => void = () => {},
) {
  const { AutoSyncOnboardingDialog } = await import('./AutoSyncOnboardingDialog');
  render(<AutoSyncOnboardingDialog open={true} variant={variant} onResolved={onResolved} />);
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

  test('full variant renders the bidirectional prompt without a close affordance', async () => {
    writer = () => ({ ok: true });
    await renderDialog('full');

    expect(screen.getByRole('button', { name: 'Enable auto-sync' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Keep disabled' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('Heads up');
  });

  test('pull variant explains one-directional sync and that edits stay local', async () => {
    writer = () => ({ ok: true });
    await renderDialog('follow');

    expect(screen.getByRole('button', { name: 'Enable Follow' })).not.toBeNull();
    const note = screen.getByRole('note').textContent ?? '';
    expect(note).toContain('Updates flow in');
    expect(note).toContain('stay only on this machine');
  });

  test('persists the resolved mode per variant through the writer', async () => {
    const modeWrites: SyncMode[] = [];
    writer = (mode) => {
      modeWrites.push(mode);
      return { ok: true };
    };

    await renderDialog('full');
    await userEvent.click(screen.getByRole('button', { name: 'Enable auto-sync' }));
    expect(modeWrites).toEqual(['full']);

    cleanup();
    modeWrites.length = 0;
    await renderDialog('follow');
    await userEvent.click(screen.getByRole('button', { name: 'Enable Follow' }));
    expect(modeWrites).toEqual(['follow']);
  });

  test('Keep disabled writes mode off in either variant', async () => {
    const modeWrites: SyncMode[] = [];
    writer = (mode) => {
      modeWrites.push(mode);
      return { ok: true };
    };
    await renderDialog('follow');
    await userEvent.click(screen.getByRole('button', { name: 'Keep disabled' }));
    expect(modeWrites).toEqual(['off']);
  });

  test('disables both choices until the project-local sync writer is ready', async () => {
    writer = null;
    await renderDialog('follow');

    expect(
      (screen.getByRole('button', { name: 'Enable Follow' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Keep disabled' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test('surfaces writer failures without resolving the dialog', async () => {
    const resolvedCalls: string[] = [];
    writer = () => ({ ok: false, error: 'binding unavailable' });
    await renderDialog('full', () => resolvedCalls.push('resolved'));

    await userEvent.click(screen.getByRole('button', { name: 'Enable auto-sync' }));

    expect(resolvedCalls).toEqual([]);
    expect(toastErrors).toEqual(['Could not enable sync: binding unavailable']);
  });

  test('Escape does not resolve the non-dismissible prompt', async () => {
    const resolvedCalls: string[] = [];
    writer = () => ({ ok: true });
    await renderDialog('full', () => resolvedCalls.push('resolved'));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enable auto-sync' })).not.toBeNull();
    });
    expect(resolvedCalls).toEqual([]);
  });
});
