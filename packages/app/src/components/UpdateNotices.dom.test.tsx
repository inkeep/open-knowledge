import type { OkUpdateRelaunchFailedInfo } from '@inkeep/open-knowledge-core/desktop-bridge';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { NoticeCard } from './UpdateNotices';
import {
  attachUpdateSubscribers,
  TOAST_A_PROGRESS_BODY,
  type UpdateNotice,
} from './UpdateNotices.shared';

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

describe('NoticeCard — update no longer pending', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders the not-ready copy with a Check for updates button that starts a check', () => {
    let relaunchFailed: ((info: OkUpdateRelaunchFailedInfo) => void) | undefined;
    const checkNow = vi.fn(() => Promise.resolve());
    const noop = () => () => {};
    const bridge = {
      onUpdateDownloaded: noop,
      onUpdateRelaunching: noop,
      onUpdateFetchingLatest: noop,
      onUpdateRelaunchFailed: (cb: (info: OkUpdateRelaunchFailedInfo) => void) => {
        relaunchFailed = cb;
        return () => {};
      },
      onWhatsNew: noop,
      onWhatsNewDismissed: noop,
      onUpdateStuckHint: noop,
      onUpdateManualCheck: noop,
      update: { relaunchNow: vi.fn(), checkNow, dismissWhatsNew: vi.fn() },
    } as unknown as OkDesktopBridge;
    const notices: UpdateNotice[] = [];
    attachUpdateSubscribers(bridge, (n) => notices.push(n));

    relaunchFailed?.({ version: '', reason: 'no-longer-pending', dismissPending: true });
    const notice = notices.at(-1);
    if (!notice) throw new Error('expected a notice');
    render(<NoticeCard notice={notice} onDismiss={() => {}} />);

    expect(screen.getByText('This update is no longer ready to install.')).toBeDefined();
    expect(screen.queryByText(/restart manually/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(checkNow).toHaveBeenCalledTimes(1);
  });
});
