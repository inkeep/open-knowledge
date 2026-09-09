import type { UninstallNoticeScreen as UninstallNoticeSpec } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { UninstallNoticeScreen } from './UninstallNoticeScreen';

const CONFIRM_NOTICE: UninstallNoticeSpec = {
  title: 'Uninstall OpenKnowledge?',
  paragraphs: [
    'This removes OpenKnowledge’s settings and integrations from your Mac, but keeps your markdown content and authored skills.',
    'OpenKnowledge will quit before cleanup starts. A dialog will show the result and help you remove the app itself.',
  ],
  confirmLabel: 'Uninstall OpenKnowledge',
  cancelLabel: 'Cancel',
  danger: true,
};

const FAILURE_NOTICE: UninstallNoticeSpec = {
  title: 'Cleanup didn’t finish',
  paragraphs: ['Some files may not have been removed — details below.'],
  log: 'Deinitializing project: /Users/dev/Notes\ndeinit=1 global=0',
  footnote: 'Also saved to /Users/dev/Library/Logs/OpenKnowledge/uninstall.log',
  confirmLabel: 'Continue',
};

function renderNotice(notice: UninstallNoticeSpec) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<UninstallNoticeScreen notice={notice} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel, user: userEvent.setup() };
}

describe('uninstall notice screen', () => {
  afterEach(cleanup);

  test('shows the confirm question with both answers', async () => {
    const { user, onConfirm, onCancel } = renderNotice(CONFIRM_NOTICE);

    expect(screen.getByRole('alertdialog', { name: 'Uninstall OpenKnowledge?' })).toBeDefined();
    for (const paragraph of CONFIRM_NOTICE.paragraphs) {
      expect(screen.getByText(paragraph)).toBeDefined();
    }

    await user.click(screen.getByRole('button', { name: 'Uninstall OpenKnowledge' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('cancel holds focus on the two-button notice so Return cannot uninstall', () => {
    renderNotice(CONFIRM_NOTICE);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  test('confirm holds focus on a single-button notice, where there is nothing else to choose', () => {
    renderNotice(FAILURE_NOTICE);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' }));
  });

  test('Escape cancels a two-button notice', async () => {
    const { user, onConfirm, onCancel } = renderNotice(CONFIRM_NOTICE);

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('Escape confirms a single-button notice', async () => {
    const { user, onConfirm, onCancel } = renderNotice(FAILURE_NOTICE);

    await user.keyboard('{Escape}');

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('shows the cleanup detail and where the full log was written', () => {
    renderNotice(FAILURE_NOTICE);

    expect(screen.getByText('Some files may not have been removed — details below.')).toBeDefined();
    expect(
      screen.getByText('Also saved to /Users/dev/Library/Logs/OpenKnowledge/uninstall.log'),
    ).toBeDefined();

    const log = screen.getByRole('region', { name: 'Cleanup log' });
    expect(log.textContent).toContain('deinit=1 global=0');
    expect(log.getAttribute('tabindex')).toBe('0');
  });
});
