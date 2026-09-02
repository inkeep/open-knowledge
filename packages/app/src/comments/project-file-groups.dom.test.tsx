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

let selected: string[] = ['t1', 't2'];

vi.doMock('./store', () => ({
  useQueueSelection: () => selected,
  setSendingAll: (ids: readonly string[], sending: boolean) => {
    bulkCalls.push({ ids: [...ids], sending });
  },
  useOpenThread: () => null,
  getOpenThread: () => null,
  subscribeOpenThread: () => () => {},
  subscribeFocusThread: () => () => {},
  toggleSending: () => {},
  deleteThread: () => {},
  editComment: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  clearActiveThread: () => {},
}));

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
    expect(screen.getByText('comment t1')).toBeTruthy();
    expect(screen.getByText('comment t3')).toBeTruthy();
    for (const trigger of screen.getAllByRole('button', { expanded: true })) {
      expect(trigger.getAttribute('data-state')).toBe('open');
    }
  });

  test('no tick lives inside the fold control', async () => {
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
    fireEvent.click(screen.getByTitle('recipes/stir-fry'));

    expect(screen.queryByText('comment t1')).toBeNull();
    expect(screen.getByText('comment t3')).toBeTruthy();

    fireEvent.click(screen.getByTitle('recipes/stir-fry'));
    expect(screen.getByText('comment t1')).toBeTruthy();
  });
});

describe('the list-level select all', () => {
  test('carries no visible label — the hint above already says what checked means', async () => {
    await renderPanel();
    expect(screen.queryByText(/select all/i)).toBeNull();
    expect(screen.getByTestId('comment-queue-select-all').getAttribute('aria-label')).toBeTruthy();
  });

  test('reads how many of the listed comments are going out', async () => {
    await renderPanel();
    expect(screen.getByText('2/3')).toBeTruthy();
  });

  test('a partly-ticked list offers the tick, not the un-tick', async () => {
    await renderPanel();
    const selectAll = screen.getByTestId('comment-queue-select-all');
    expect(selectAll.getAttribute('aria-label')).toMatch(/mark every comment to send/i);
    expect(selectAll.getAttribute('aria-checked')).toBe('false');
  });
});

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
    expect(tick.className).toContain('focus-visible:opacity-100');
    expect(tick.className).not.toContain('focus-within');
    expect(tick.getAttribute('disabled')).toBeNull();
  });

  test('reads checked when every comment in the file is going', async () => {
    await renderPanel();
    expect(
      screen.getByTestId('comment-queue-file-select-recipes/stir-fry').getAttribute('data-state'),
    ).toBe('checked');
  });

  test('reads mixed when only some of the file is going', async () => {
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
    selected = [];
    await renderWithResolvedShown(RESOLVED);
    const tick = screen.getByTestId('comment-queue-file-select-recipes/soup');
    expect(tick.getAttribute('disabled')).not.toBeNull();

    fireEvent.click(tick);
    expect(bulkCalls).toEqual([]);
  });
});
