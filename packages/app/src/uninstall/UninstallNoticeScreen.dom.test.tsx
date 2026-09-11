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
  const onRevealLog = vi.fn();
  render(
    <UninstallNoticeScreen
      notice={notice}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onRevealLog={onRevealLog}
    />,
  );
  return { onConfirm, onCancel, onRevealLog, user: userEvent.setup() };
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

const SUCCESS_NOTICE = {
  title: 'OpenKnowledge files were removed',
  subtitle: "Almost done. Here's what happened and what's left.",
  paragraphs: [],
  checklist: [
    {
      label: 'Kept your content',
      detail: 'Markdown files and authored skills were left untouched.',
      done: true,
    },
    {
      label: 'Removed OpenKnowledge files',
      detail: 'Settings and integrations were cleaned up.',
      done: true,
    },
    {
      label: 'Move OpenKnowledge.app to the Trash',
      detail: 'Reveal in Finder shows the app so you can drag it to the Trash.',
      done: false,
    },
  ],
  logRevealLabel: 'Cleanup log',
  confirmLabel: 'Reveal in Finder',
};

test('shows completed cleanup and the remaining app removal step with separate actions', async () => {
  const { user, onConfirm, onRevealLog } = renderNotice(SUCCESS_NOTICE);
  expect(screen.getByText(SUCCESS_NOTICE.subtitle)).toBeDefined();
  const items = screen.getAllByRole('listitem');
  expect(items).toHaveLength(3);
  expect(items[0]?.textContent).toContain('Done.');
  expect(items[1]?.textContent).toContain('Done.');
  expect(items[2]?.textContent).toContain('To do.');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reveal in Finder' }));
  await user.click(screen.getByRole('button', { name: 'Cleanup log' }));
  expect(onRevealLog).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

test('dismisses a completion notice on Escape without revealing the app', async () => {
  const { user, onConfirm, onCancel } = renderNotice(SUCCESS_NOTICE);
  await user.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

test('keeps an inline failure log reachable by keyboard', async () => {
  const { user } = renderNotice(FAILURE_NOTICE);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Cleanup log' }));
});

test('announces the completion subtitle as part of the modal description', () => {
  renderNotice(SUCCESS_NOTICE);
  const dialog = screen.getByRole('alertdialog');
  const description = dialog
    .getAttribute('aria-describedby')
    ?.split(' ')
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ');
  expect(description).toContain(SUCCESS_NOTICE.subtitle);
  expect(dialog.getAttribute('aria-modal')).toBe('true');
});

test('wraps focus from the first and last control in the failure notice', async () => {
  const { user } = renderNotice(FAILURE_NOTICE);
  const log = screen.getByRole('region', { name: 'Cleanup log' });
  const confirm = screen.getByRole('button', { name: FAILURE_NOTICE.confirmLabel });
  confirm.focus();
  await user.tab();
  expect(document.activeElement).toBe(log);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(confirm);
});
