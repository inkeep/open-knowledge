/**
 * The This-project scope's per-file groups.
 *
 * Properties that are easy to lose in a restyle: groups arrive OPEN — comments
 * are hand-written and few, so folding them by default would hide the panel
 * behind a click — folding is reachable both per-file and for all of them at
 * once, and the file header carries a tick that is REVEALED on hover rather than
 * resident. Selection otherwise lives on the cards and, for all of them at once,
 * at the head of the list.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CommentThread } from './types';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

// The send list, doubled and mutable: everything on the first file is ticked,
// nothing on the second — so the file ticks have both states to show, and a test
// can narrow it to exercise the mixed one.
let selected: string[] = ['t1', 't2'];

vi.doMock('./store', () => ({
  useQueueSelection: () => selected,
  setSendingAll: (ids: readonly string[], sending: boolean) => {
    bulkCalls.push({ ids: [...ids], sending });
  },
  usePinnedThread: () => null,
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
    updatedAt: 1000,
    queued: true,
  };
}

const bulkCalls: { ids: string[]; sending: boolean }[] = [];

const THREADS = [
  thread('t1', 'recipes/stir-fry'),
  thread('t2', 'recipes/stir-fry'),
  thread('t3', 'recipes/soup'),
];

async function renderPanel(threads: readonly CommentThread[] = THREADS) {
  const { CommentListPanel } = await import('./CommentListPanel');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  // Production wraps the whole app in one provider (main.tsx); the collapse-all
  // control's tooltip throws without it.
  return render(
    <TooltipProvider>
      <CommentListPanel
        threads={threads}
        groupByDocument
        empty="none"
        testIdPrefix="comment-queue"
      />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  selected = ['t1', 't2'];
  bulkCalls.length = 0;
});

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

  test('no tick lives inside the fold control', async () => {
    // A tick nested in the trigger would fold the group on its way to changing
    // the batch. The file's own tick is a sibling of it, not a child.
    await renderPanel();
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

/**
 * The bulk tick moved out of the footer to the head of the list.
 *
 * Down beside the send it was a second, differently-placed control over the same
 * column; at the top it lines up with the per-card ticks it toggles. The count
 * came with it — it answers what the send is about to carry, which is the one
 * thing the row has to keep saying wherever it lives.
 */
describe('the list-level select all', () => {
  test('carries no visible label — the hint above already says what checked means', async () => {
    await renderPanel();
    expect(screen.queryByText(/select all/i)).toBeNull();
    // The name lives on the control itself, so nothing is lost to a reader who
    // cannot see the tick's alignment with the cards below it.
    expect(screen.getByTestId('comment-queue-select-all').getAttribute('aria-label')).toBeTruthy();
  });

  test('reads how many of the listed comments are going out', async () => {
    await renderPanel();
    // Two of the three are ticked, which is the state the count exists for — a
    // row that only ever read n/n would say nothing the tick did not.
    expect(screen.getByText('2/3')).toBeTruthy();
  });

  test('a partly-ticked list offers the tick, not the un-tick', async () => {
    await renderPanel();
    // The label names the click AHEAD. With one comment still out, that click
    // completes the set rather than clearing it.
    const selectAll = screen.getByTestId('comment-queue-select-all');
    expect(selectAll.getAttribute('aria-label')).toMatch(/mark every comment to send/i);
    expect(selectAll.getAttribute('aria-checked')).toBe('false');
  });
});

/**
 * The per-file tick, revealed rather than resident.
 *
 * Drawn at rest it sat higher and further left than the card ticks it
 * summarizes, reading as the primary control, and put a checkbox on every
 * heading in a panel whose headings are otherwise labels. Hidden by OPACITY, not
 * unmounted: a control that leaves the tab order is one a keyboard reader cannot
 * reach at all.
 */
describe('the per-file tick', () => {
  test('there is one per file, beside the heading', async () => {
    await renderPanel();
    expect(screen.getByTestId('comment-queue-file-select-recipes/stir-fry')).toBeTruthy();
    expect(screen.getByTestId('comment-queue-file-select-recipes/soup')).toBeTruthy();
  });

  test('is transparent at rest but still focusable', async () => {
    await renderPanel();
    const tick = screen.getByTestId('comment-queue-file-select-recipes/stir-fry');
    expect(tick.className).toContain('opacity-0');
    // The reveal is hover or KEYBOARD focus, so the element must stay in the
    // tree and in the tab order — `hidden` or an unmounted node would take both
    // away.
    expect(tick.className).toContain('focus-visible:opacity-100');
    // Not `focus-within`: a mouse click leaves the box focused, which kept the
    // tick revealed after the pointer left.
    expect(tick.className).not.toContain('focus-within');
    expect(tick.getAttribute('disabled')).toBeNull();
  });

  test('reads checked when every comment in the file is going', async () => {
    // t1 + t2 are the whole of stir-fry, and both are ticked.
    await renderPanel();
    expect(
      screen.getByTestId('comment-queue-file-select-recipes/stir-fry').getAttribute('data-state'),
    ).toBe('checked');
  });

  test('reads mixed when only some of the file is going', async () => {
    // Mixed rather than off: off would offer to "select all" a file already half
    // in, and the click would look like it had done nothing to the ticked ones.
    selected = ['t1'];
    await renderPanel();
    expect(
      screen.getByTestId('comment-queue-file-select-recipes/stir-fry').getAttribute('data-state'),
    ).toBe('indeterminate');
  });

  test('reads unchecked when none of the file is going', async () => {
    await renderPanel();
    expect(
      screen.getByTestId('comment-queue-file-select-recipes/soup').getAttribute('data-state'),
    ).toBe('unchecked');
  });

  test('ticks the whole file, and only that file', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('comment-queue-file-select-recipes/soup'));
    expect(bulkCalls).toEqual([{ ids: ['t3'], sending: true }]);
  });

  test('a fully-ticked file offers the un-tick', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('comment-queue-file-select-recipes/stir-fry'));
    expect(bulkCalls).toEqual([{ ids: ['t1', 't2'], sending: false }]);
  });
});

/**
 * The per-file tick once resolved comments are on screen.
 *
 * A resolved comment is out of the batch entirely — the queue drops it, so it
 * can never be among the ticked. Counted as part of its file anyway, the file
 * could never reach "all", and the click meant to tick the file fired queue
 * requests for threads that cannot be queued.
 */
describe('the per-file tick with resolved comments shown', () => {
  const RESOLVED = [
    thread('t1', 'recipes/stir-fry'),
    { ...thread('t2', 'recipes/stir-fry'), status: 'resolved' as const },
    { ...thread('t3', 'recipes/soup'), status: 'resolved' as const },
  ];

  async function renderWithResolvedShown(threads: readonly CommentThread[]) {
    const view = await renderPanel(threads);
    fireEvent.click(screen.getByTestId('comment-queue-resolved-toggle'));
    return view;
  }

  test('reads checked when every SENDABLE comment in the file is going', async () => {
    // t1 is the only comment on stir-fry that a send could carry, and it is
    // ticked — so the file is fully ticked, resolved neighbour or not.
    selected = ['t1'];
    await renderWithResolvedShown(RESOLVED);
    expect(
      screen.getByTestId('comment-queue-file-select-recipes/stir-fry').getAttribute('data-state'),
    ).toBe('checked');
  });

  test('ticking a file leaves its resolved comments out of the request', async () => {
    selected = [];
    await renderWithResolvedShown(RESOLVED);
    fireEvent.click(screen.getByTestId('comment-queue-file-select-recipes/stir-fry'));
    expect(bulkCalls).toEqual([{ ids: ['t1'], sending: true }]);
  });

  test('a file with nothing left to send offers an inert tick', async () => {
    // Every comment on soup is resolved. The tick stays in the row so the
    // heading lines up with the others, but there is nothing for it to do.
    selected = [];
    await renderWithResolvedShown(RESOLVED);
    const tick = screen.getByTestId('comment-queue-file-select-recipes/soup');
    expect(tick.getAttribute('disabled')).not.toBeNull();

    fireEvent.click(tick);
    expect(bulkCalls).toEqual([]);
  });
});
