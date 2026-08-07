/**
 * The in-document popover's send tick reflects the store.
 *
 * The popover renders the panels' card, and for a while it rendered it without
 * saying whether the comment was ticked. The box drew permanently unchecked
 * while the click behind it went through to the store — state and view
 * disagreeing, which reads as "the checkbox is broken" when nothing about the
 * send was. The prop is required now, so a host that forgets cannot compile;
 * this covers the half a type cannot: that the value passed is the LIVE one.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
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

const THREAD: CommentThread = {
  id: 't1',
  docName: 'recipes/wiki',
  target: { kind: 'body' },
  anchor: { quote: "er's d", prefix: '', suffix: '', start: 0, end: 6 },
  status: 'open',
  body: 'hi',
  createdAt: 1000,
  queued: true,
};

// `t1` is in the send list — the state the popover used to draw as unchecked.
vi.doMock('./store', () => ({
  useCommentThreads: () => [THREAD],
  useQueueSelection: () => ['t1'],
  subscribeOpenThreadPopover: (cb: (id: string | null) => void) => {
    openPopover = cb;
    return () => {
      openPopover = null;
    };
  },
  emitOpenThreadPopover: () => {},
  toggleSending: () => {},
  deleteThread: () => {},
  editComment: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  clearActiveThread: () => {},
}));

// Positioning reads a live ProseMirror view; nothing here is about where the
// card lands.
vi.doMock('@/editor/utils/get-editor-view', () => ({ getEditorView: () => null }));
vi.doMock('./anchor-search', () => ({
  findQuoteRange: () => null,
  captureSelectionContext: () => ({ prefix: '', suffix: '' }),
}));
vi.doMock('./property-row-rect', () => ({
  propertyRowRect: () => null,
  revealPropertyValueRange: () => true,
}));

let openPopover: ((id: string | null) => void) | null = null;

afterEach(() => {
  cleanup();
  openPopover = null;
});

describe('the thread popover', () => {
  test('draws its tick from the send list, not from nothing', async () => {
    const { CommentThreadPopover } = await import('./CommentThreadPopover');
    // biome-ignore lint/suspicious/noExplicitAny: structural editor double
    render(<CommentThreadPopover editor={{ state: {} } as any} docName="recipes/wiki" />);
    openPopover?.('t1');

    const tick = await screen.findByRole('checkbox');
    expect(tick.getAttribute('data-state')).toBe('checked');
  });
});
