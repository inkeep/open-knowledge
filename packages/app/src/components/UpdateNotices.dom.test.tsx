/**
 * Render tests for `NoticeCard` — the dismiss-X visibility contract.
 *
 * The pure subscription logic (notice shape, `dismissible: false` on the
 * in-progress card) is covered in `UpdateNotices.test.ts`. This file pins the
 * one thing only a renderer can prove: a `dismissible: false` notice draws no
 * dismiss X, in BOTH the single-row and the stacked (secondaryAction) layouts,
 * while a default notice still draws (and wires) the X.
 *
 * Lingui macros resolve through the English-passthrough shim registered by
 * `tests/lingui-macro-preload.ts`, so `t`Dismiss notice`` is the X's
 * accessible name. Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NoticeCard } from './UpdateNotices';
import { TOAST_A_PROGRESS_BODY, type UpdateNotice } from './UpdateNotices.shared';

const DISMISS_NAME = 'Dismiss notice';

describe('NoticeCard — dismiss X visibility', () => {
  afterEach(() => {
    cleanup();
  });

  test('a default notice renders the dismiss X and wires it to onDismiss', () => {
    const notice: UpdateNotice = {
      id: 'update-downloaded',
      body: 'Version 1.2.3 ready to install',
      priority: 2,
      action: { label: 'Relaunch', onClick: () => {} },
    };
    const onDismiss = mock(() => {});
    render(<NoticeCard notice={notice} onDismiss={onDismiss} />);

    const x = screen.getByRole('button', { name: DISMISS_NAME });
    fireEvent.click(x);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('the in-progress relaunch card (dismissible: false) renders no dismiss X', () => {
    const notice: UpdateNotice = {
      id: 'update-downloaded',
      body: TOAST_A_PROGRESS_BODY,
      priority: 2,
      dismissible: false,
    };
    render(<NoticeCard notice={notice} onDismiss={() => {}} />);

    // Body still shows so the user sees progress…
    expect(screen.getByText(TOAST_A_PROGRESS_BODY)).toBeDefined();
    // …but there is nothing to dismiss.
    expect(screen.queryByRole('button', { name: DISMISS_NAME })).toBeNull();
  });

  test('dismissible: false also drops the X in the stacked secondaryAction layout', () => {
    const notice: UpdateNotice = {
      id: 'two-action',
      body: 'Decide something',
      priority: 0,
      dismissible: false,
      action: { label: 'Continue', onClick: () => {} },
      secondaryAction: { label: 'Stay', onClick: () => {} },
    };
    render(<NoticeCard notice={notice} onDismiss={() => {}} />);

    expect(screen.queryByRole('button', { name: DISMISS_NAME })).toBeNull();
    // The action buttons in the stacked layout are unaffected.
    expect(screen.getByText('Continue')).toBeDefined();
    expect(screen.getByText('Stay')).toBeDefined();
  });
});
