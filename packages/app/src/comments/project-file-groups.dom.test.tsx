/**
 * The This-project scope's per-file groups.
 *
 * Properties that are easy to lose in a restyle: groups arrive OPEN — comments
 * are hand-written and few, so folding them by default would hide the panel
 * behind a click — folding is reachable both per-file and for all of them at
 * once, and the file header folds WITHOUT carrying a selection control.
 * Selection lives on the cards and in the footer; a file-level tick duplicated
 * the card's own the moment a file held a single comment.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CommentThread } from './types';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

// The send list, doubled: everything on the first file is ticked, nothing on
// the second — so a header that had grown a tick would have both states to show.
vi.doMock('./store', () => ({
  useQueueSelection: () => ['t1', 't2'],
  subscribeFocusThread: () => () => {},
  toggleSending: () => {},
  deleteThread: () => {},
  editComment: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  clearActiveThread: () => {},
}));

// The footer drags in the agent picker and the sessions dock; neither is what
// these tests are about.
vi.doMock('./CommentSendFooter', () => ({ CommentSendFooter: () => null }));

function thread(id: string, docName: string): CommentThread {
  return {
    id,
    docName,
    target: { kind: 'body' },
    anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
    status: 'open',
    body: `comment ${id}`,
    createdAt: 1000,
    queued: true,
  };
}

const THREADS = [
  thread('t1', 'recipes/stir-fry'),
  thread('t2', 'recipes/stir-fry'),
  thread('t3', 'recipes/soup'),
];

async function renderPanel() {
  const { CommentListPanel } = await import('./CommentListPanel');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  // Production wraps the whole app in one provider (main.tsx); the collapse-all
  // control's tooltip throws without it.
  return render(
    <TooltipProvider>
      <CommentListPanel
        threads={THREADS}
        groupByDocument
        empty="none"
        testIdPrefix="comment-queue"
      />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe('the project scope grouped by file', () => {
  test('mounts with every file open', async () => {
    await renderPanel();
    // Every comment is readable without a click — the whole reason these mount
    // expanded rather than following the Problems panel's collapsed default.
    expect(screen.getByText('comment t1')).toBeTruthy();
    expect(screen.getByText('comment t3')).toBeTruthy();
    for (const trigger of screen.getAllByRole('button', { expanded: true })) {
      expect(trigger.getAttribute('data-state')).toBe('open');
    }
  });

  test('the file header carries no selection control of its own', async () => {
    await renderPanel();
    // One tick per comment and one in the footer (stubbed out here), never a
    // third on the heading — with a single comment in a file that third was the
    // same click as the card's, one row higher and further left.
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    for (const tick of screen.getAllByRole('checkbox')) {
      expect(tick.closest('[data-slot="collapsible-trigger"]')).toBeNull();
    }
  });

  test('collapse-all folds every file, and the same control brings them back', async () => {
    await renderPanel();
    const toggle = screen.getByTestId('comment-queue-collapse-toggle');

    fireEvent.click(toggle);
    expect(screen.queryByText('comment t1')).toBeNull();
    expect(screen.queryByText('comment t3')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByText('comment t1')).toBeTruthy();
  });

  test('a file header folds its own comments and nothing else', async () => {
    await renderPanel();
    // Per-file only: there is no collapse-all in the panel header, so folding
    // one file must leave its neighbours exactly as they were.
    fireEvent.click(screen.getByTitle('recipes/stir-fry'));

    expect(screen.queryByText('comment t1')).toBeNull();
    expect(screen.getByText('comment t3')).toBeTruthy();

    fireEvent.click(screen.getByTitle('recipes/stir-fry'));
    expect(screen.getByText('comment t1')).toBeTruthy();
  });
});
