import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
}));

async function renderDialog(props: {
  variant?: 'full' | 'pull';
  strandedCommitCount?: number;
  onConfirm?: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const { EnableSyncConfirmDialog } = await import('./EnableSyncConfirmDialog');
  render(
    <EnableSyncConfirmDialog
      open={true}
      onOpenChange={props.onOpenChange ?? (() => {})}
      onConfirm={props.onConfirm ?? (() => {})}
      variant={props.variant}
      strandedCommitCount={props.strandedCommitCount}
    />,
  );
}

describe('EnableSyncConfirmDialog', () => {
  afterEach(() => cleanup());

  test('full variant (default) shows the bidirectional warning and no stranded disclosure', async () => {
    await renderDialog({ strandedCommitCount: 3 });
    expect(screen.getByRole('button', { name: 'Enable Auto (Pull and Push)' })).not.toBeNull();
    const note = screen.getByRole('note').textContent ?? '';
    expect(note).toContain('Commits happen automatically');
    // Stranded disclosure is pull-only; a full enable pushes the commits, so it
    // must not appear even when a count is passed.
    expect(screen.queryByText(/stay on this computer/i)).toBeNull();
  });

  test('pull variant shows the one-directional warning', async () => {
    await renderDialog({ variant: 'follow' });
    expect(screen.getByRole('button', { name: 'Enable Auto (Pull only)' })).not.toBeNull();
    expect(screen.getByRole('note').textContent ?? '').toContain('Updates flow in');
    expect(screen.queryByText(/haven't shared/i)).toBeNull();
  });

  test('pull variant discloses stranded commits (plural)', async () => {
    await renderDialog({ variant: 'follow', strandedCommitCount: 2 });
    expect(
      screen.getByText("You have 2 changes you haven't shared. They will stay on this computer."),
    ).not.toBeNull();
  });

  test('pull variant discloses stranded commits (singular)', async () => {
    await renderDialog({ variant: 'follow', strandedCommitCount: 1 });
    expect(
      screen.getByText("You have 1 change you haven't shared. It will stay on this computer."),
    ).not.toBeNull();
  });

  test('confirm fires the callback', async () => {
    const confirms: string[] = [];
    await renderDialog({ variant: 'follow', onConfirm: () => confirms.push('ok') });
    await userEvent.click(screen.getByRole('button', { name: 'Enable Auto (Pull only)' }));
    expect(confirms).toEqual(['ok']);
  });
});
