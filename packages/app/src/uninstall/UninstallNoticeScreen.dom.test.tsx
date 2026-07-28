import type { UninstallNoticeScreen as UninstallNoticeSpec } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { UninstallNoticeScreen } from './UninstallNoticeScreen';

/** The two-button shape: a question whose safe answer is Cancel. */
const CONFIRM_NOTICE: UninstallNoticeSpec = {
  title: 'Uninstall OpenKnowledge?',
  paragraphs: [
    'This removes OpenKnowledge’s settings and integrations from your Mac, but keeps your markdown content and authored skills.',
    'When cleanup finishes, OpenKnowledge will help you remove the app itself, then quit.',
  ],
  confirmLabel: 'Uninstall OpenKnowledge',
  cancelLabel: 'Cancel',
  danger: true,
};

/** The single-button shape: an acknowledgement with a recap and one action left. */
const COMPLETION_NOTICE: UninstallNoticeSpec = {
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
      detail: 'Cleaned up, including from 2 projects.',
      done: true,
    },
    {
      label: 'Move OpenKnowledge.app to the Trash',
      detail:
        'Reveal in Finder shows the app and quits OpenKnowledge, so you can drag it to the Trash.',
      done: false,
    },
  ],
  logRevealLabel: 'Cleanup log',
  confirmLabel: 'Reveal in Finder',
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
    renderNotice(COMPLETION_NOTICE);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reveal in Finder' }));
  });

  // The asymmetry main also applies to a window close: an unanswered question
  // must not proceed, while an acknowledgement has no other outcome to reach.
  test('Escape cancels a two-button notice', async () => {
    const { user, onConfirm, onCancel } = renderNotice(CONFIRM_NOTICE);

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('Escape confirms a single-button notice', async () => {
    const { user, onConfirm, onCancel } = renderNotice(COMPLETION_NOTICE);

    await user.keyboard('{Escape}');

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('recaps what was kept and removed, and what the user still has to do', () => {
    renderNotice(COMPLETION_NOTICE);

    expect(screen.getByText("Almost done. Here's what happened and what's left.")).toBeDefined();
    for (const item of COMPLETION_NOTICE.checklist ?? []) {
      expect(screen.getByText(item.label)).toBeDefined();
      if (item.detail !== undefined) expect(screen.getByText(item.detail)).toBeDefined();
    }

    // State reaches a screen reader as a word, not only as the check glyph.
    expect(screen.getAllByText('Done.')).toHaveLength(2);
    expect(screen.getAllByText('To do.')).toHaveLength(1);
  });

  test('revealing the log leaves the notice up', async () => {
    const { user, onConfirm, onRevealLog } = renderNotice(COMPLETION_NOTICE);

    await user.click(screen.getByRole('button', { name: 'Cleanup log' }));

    expect(onRevealLog).toHaveBeenCalledTimes(1);
    // Revealing is not an answer — settling here would quit the flow early.
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('offers no log reveal when there is no log to reveal', () => {
    renderNotice(CONFIRM_NOTICE);

    expect(screen.queryByRole('button', { name: 'Cleanup log' })).toBeNull();
  });

  test('shows the cleanup detail and where the full log was written', () => {
    renderNotice(FAILURE_NOTICE);

    expect(screen.getByText('Some files may not have been removed — details below.')).toBeDefined();
    expect(
      screen.getByText('Also saved to /Users/dev/Library/Logs/OpenKnowledge/uninstall.log'),
    ).toBeDefined();

    // Keyboard users have to be able to scroll the log, so it is a named region.
    const log = screen.getByRole('region', { name: 'Cleanup log' });
    expect(log.textContent).toContain('deinit=1 global=0');
    expect(log.getAttribute('tabindex')).toBe('0');
  });
});
