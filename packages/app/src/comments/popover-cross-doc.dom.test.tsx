/**
 * Several popovers, one bus.
 *
 * The editor pool keeps recently visited documents mounted, and each one hosts
 * its own `CommentThreadPopover` — but "open thread X" is a single project-wide
 * signal that reaches all of them. Only one owns X. The others used to answer by
 * BROADCASTING a close, which shut the popover the owner had just opened, and
 * which instance spoke last came down to render order: clicking a commented
 * passage worked or silently did nothing depending on how many tabs were open.
 *
 * The rule these pin: an instance may close a thread it owns and must stay
 * silent about one it does not.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CommentThread } from './types';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

function thread(id: string, docName: string): CommentThread {
  return {
    id,
    docName,
    target: { kind: 'body' },
    anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
    status: 'open',
    body: 'press it?',
    createdAt: 1000,
    updatedAt: 1000,
    queued: false,
  };
}

const ALFREDO = thread('t-alfredo', 'recipes/chicken-alfredo-pasta');
const SATAY = thread('t-satay', 'recipes/chicken-satay');
const ALL = [ALFREDO, SATAY];

let openPopover: ((id: string | null) => void) | null = null;
const emitted: (string | null)[] = [];

vi.doMock('./store', () => ({
  useCommentThreads: (docName: string) => ALL.filter((t) => t.docName === docName),
  useAllThreads: () => ALL,
  useQueueSelection: () => [],
  subscribeOpenThreadPopover: (cb: (id: string | null) => void) => {
    // Every mounted instance subscribes; the real bus fans out to all of them,
    // which is the whole point of this file.
    const previous = openPopover;
    openPopover = (id) => {
      previous?.(id);
      cb(id);
    };
    return () => {
      openPopover = previous;
    };
  },
  emitOpenThreadPopover: (id: string | null) => {
    emitted.push(id);
  },
  toggleSending: () => {},
  deleteThread: () => {},
  editComment: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  clearActiveThread: () => {},
}));

vi.doMock('@/editor/utils/get-editor-view', () => ({ getEditorView: () => null }));
vi.doMock('./anchor-search', () => ({
  findQuoteRange: () => ({ from: 0, to: 8 }),
  captureSelectionContext: () => ({ prefix: '', suffix: '' }),
}));
vi.doMock('./property-row-rect', () => ({
  propertyRowRect: () => null,
  revealPropertyValueRange: () => true,
}));

const { CommentThreadPopover } = await import('./CommentThreadPopover');

/** Two docs in the pool, each with its own popover — the real arrangement. */
function Pool() {
  return (
    <TooltipProvider>
      {/* biome-ignore lint/suspicious/noExplicitAny: structural editor double */}
      <CommentThreadPopover editor={{ state: {} } as any} docName="recipes/chicken-satay" />
      {/* biome-ignore lint/suspicious/noExplicitAny: structural editor double */}
      <CommentThreadPopover editor={{ state: {} } as any} docName="recipes/chicken-alfredo-pasta" />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  openPopover = null;
  emitted.length = 0;
});

describe('a pool of thread popovers', () => {
  test('a thread opens even with another document mounted beside it', async () => {
    render(<Pool />);
    openPopover?.('t-alfredo');

    expect(await screen.findByText('press it?')).toBeTruthy();
  });

  test('the non-owning instance does not broadcast a close', async () => {
    render(<Pool />);
    openPopover?.('t-alfredo');
    await screen.findByText('press it?');

    // Silence is the assertion. A `null` here is the sibling shutting the
    // popover its neighbour just opened.
    expect(emitted).toEqual([]);
  });

  test('exactly one instance renders the thread', async () => {
    render(<Pool />);
    openPopover?.('t-alfredo');
    await screen.findByText('press it?');

    expect(screen.getAllByText('press it?')).toHaveLength(1);
  });

  test('a thread that exists nowhere still closes', async () => {
    render(<Pool />);
    openPopover?.('t-deleted');

    // Nobody owns it and nobody can show it, so the close is right — this is the
    // case the silence rule must not swallow.
    await vi.waitFor(() => expect(emitted).toContain(null));
  });
});
