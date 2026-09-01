import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
    const onDismiss = vi.fn(() => {});
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

    expect(screen.getByText(TOAST_A_PROGRESS_BODY)).toBeDefined();
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
    expect(screen.getByText('Continue')).toBeDefined();
    expect(screen.getByText('Stay')).toBeDefined();
  });
});
