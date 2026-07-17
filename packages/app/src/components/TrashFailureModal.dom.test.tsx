import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import type { TrashFailedTarget } from './TrashFailureModal';

mock.module('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  plural: (
    count: number,
    forms: {
      one?: string;
      other: string;
    },
  ) => (count === 1 ? (forms.one ?? forms.other) : forms.other).replace('#', String(count)),
  t: renderLinguiTemplate,
}));

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const fileTarget: TrashFailedTarget = {
  kind: 'file',
  path: 'notes/foo.md',
  name: 'foo.md',
  reason: 'permission-denied',
  detail: 'Operation not permitted',
};

const folderTarget: TrashFailedTarget = {
  kind: 'folder',
  path: 'notes/archive',
  name: 'archive',
  reason: 'path-escape',
};

async function renderTrashFailureModal({
  failedTargets = [fileTarget],
  isSubmitting = false,
}: {
  failedTargets?: ReadonlyArray<TrashFailedTarget>;
  isSubmitting?: boolean;
} = {}) {
  const [{ Dialog }, { TrashFailureModal }] = await Promise.all([
    import('@/components/ui/dialog'),
    import('./TrashFailureModal'),
  ]);
  const onCancel = mock(() => {});
  const onRetry = mock(() => {});
  const onDeletePermanently = mock(() => {});

  render(
    <Dialog open={true}>
      <TrashFailureModal
        failedTargets={failedTargets}
        isSubmitting={isSubmitting}
        onCancel={onCancel}
        onDeletePermanently={onDeletePermanently}
        onRetry={onRetry}
      />
    </Dialog>,
  );

  return { onCancel, onDeletePermanently, onRetry };
}

describe('TrashFailureModal runtime behavior', () => {
  afterEach(() => cleanup());

  test('exports the modal component and helper functions', async () => {
    const mod = await import('./TrashFailureModal');
    expect(typeof mod.TrashFailureModal).toBe('function');
    expect(typeof mod.formatTrashFailureDetail).toBe('function');
    expect(typeof mod.coerceTrashFailureReason).toBe('function');
  });

  test('renders the single-target VSCode-parity copy and routes each action', async () => {
    const { onCancel, onDeletePermanently, onRetry } = await renderTrashFailureModal();

    const dialog = screen.getByRole('dialog', { name: "Couldn't move to Trash" });
    expect(dialog.textContent).toContain('Could not move "foo.md" to the Trash.');
    expect(dialog.textContent).toContain('Do you want to permanently delete instead?');
    expect(dialog.textContent).toContain('Reason: Permission denied (Operation not permitted)');
    expect(screen.queryByTestId('trash-failure-modal-target')).toBeNull();

    const cancel = screen.getByTestId('trash-failure-modal-cancel');
    const retry = screen.getByTestId('trash-failure-modal-retry');
    const deletePermanently = screen.getByTestId('trash-failure-modal-delete-permanently');

    expect(cancel.textContent).toBe('Cancel');
    expect(retry.textContent).toBe('Retry');
    expect(deletePermanently.textContent).toBe('Delete Permanently');
    expect(cancel.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      retry.compareDocumentPosition(deletePermanently) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(cancel.getAttribute('data-variant')).toBe('outline');
    expect(retry.getAttribute('data-variant')).toBe('outline');
    expect(deletePermanently.getAttribute('data-variant')).toBe('destructive');
    expectVisualClassTokens(cancel.className, ['font-mono']);
    expectVisualClassTokens(retry.className, ['font-mono']);

    await userEvent.click(cancel);
    await userEvent.click(retry);
    await userEvent.click(deletePermanently);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDeletePermanently).toHaveBeenCalledTimes(1);
  });

  test('disables every action while submitting and shows progress copy', async () => {
    const { onCancel, onDeletePermanently, onRetry } = await renderTrashFailureModal({
      isSubmitting: true,
    });

    const cancel = screen.getByTestId('trash-failure-modal-cancel') as HTMLButtonElement;
    const retry = screen.getByTestId('trash-failure-modal-retry') as HTMLButtonElement;
    const deletePermanently = screen.getByTestId(
      'trash-failure-modal-delete-permanently',
    ) as HTMLButtonElement;

    expect(cancel.disabled).toBe(true);
    expect(retry.disabled).toBe(true);
    expect(deletePermanently.disabled).toBe(true);
    expect(retry.textContent).toContain('Retrying');
    expect(deletePermanently.textContent).toContain('Deleting');

    await userEvent.click(cancel);
    await userEvent.click(retry);
    await userEvent.click(deletePermanently);

    expect(onCancel).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onDeletePermanently).not.toHaveBeenCalled();
  });

  test('renders multi-target failures as one aggregated list with one destructive action', async () => {
    await renderTrashFailureModal({
      failedTargets: [fileTarget, folderTarget],
    });

    const dialog = screen.getByRole('dialog', { name: "Couldn't move to Trash" });
    expect(dialog.textContent).toContain(
      '2 items could not be moved to the Trash. Do you want to permanently delete instead?',
    );

    const targets = screen.getAllByTestId('trash-failure-modal-target');
    expect(targets).toHaveLength(2);
    expect(within(targets[0]).getByText('foo.md')).toBeTruthy();
    expect(
      within(targets[0]).getByText('Reason: Permission denied (Operation not permitted)'),
    ).toBeTruthy();
    expect(within(targets[1]).getByText('archive/')).toBeTruthy();
    expect(within(targets[1]).getByText('Reason: Path resolves outside project')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Delete Permanently' })).toHaveLength(1);
  });
});
