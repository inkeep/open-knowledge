import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen } from '@testing-library/react';
import { type ReactNode, useSyncExternalStore } from 'react';
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

let openThreadId: string | null = null;
const snapshotListeners = new Set<() => void>();
const openListeners = new Set<(id: string | null) => void>();

function openThread(id: string | null): void {
  openThreadId = id;
  for (const listener of snapshotListeners) listener();
  for (const listener of openListeners) listener(id);
}

vi.doMock('./store', () => ({
  useQueueSelection: () => [],
  setSendingAll: () => {},
  getOpenThread: () => openThreadId,
  subscribeOpenThread: (onChange: (id: string | null) => void) => {
    openListeners.add(onChange);
    return () => openListeners.delete(onChange);
  },
  useOpenThread: () =>
    useSyncExternalStore(
      (onChange: () => void) => {
        snapshotListeners.add(onChange);
        return () => snapshotListeners.delete(onChange);
      },
      () => openThreadId,
      () => null,
    ),
  subscribeFocusThread: () => () => {},
  emitOpenThread: () => {},
  toggleSending: () => {},
  deleteThread: () => {},
  editComment: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  clearActiveThread: () => {},
}));

vi.doMock('./CommentSendFooter', () => ({ CommentSendFooter: () => null }));

function thread(id: string): CommentThread {
  return {
    id,
    docName: 'recipes/stir-fry',
    target: { kind: 'body' },
    anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
    status: 'open',
    body: `comment ${id}`,
    createdAt: 1000,
    updatedAt: 1000,
    queued: false,
  };
}

const THREADS = [thread('t1'), thread('t2'), thread('t3')];

const scrolled: string[] = [];

async function renderPanel() {
  const { CommentListPanel } = await import('./CommentListPanel');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  return render(
    <TooltipProvider>
      <CommentListPanel threads={THREADS} empty={<span>none</span>} testIdPrefix="comment-doc" />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  openThreadId = null;
  scrolled.length = 0;
  HTMLElement.prototype.scrollIntoView = function scrollIntoViewDouble(this: HTMLElement) {
    scrolled.push(this.textContent ?? '');
  };
});

afterEach(() => {
  cleanup();
  snapshotListeners.clear();
  openListeners.clear();
});

describe('the panel and the open thread', () => {
  test('scrolls to a thread opened BEFORE it mounted', async () => {
    openThread('t2');
    await renderPanel();

    await vi.waitFor(() => expect(scrolled.length).toBe(1));
    expect(scrolled[0]).toContain('comment t2');
  });

  test('scrolls to a thread opened while it is already up', async () => {
    await renderPanel();
    expect(scrolled).toEqual([]);

    act(() => openThread('t3'));

    await vi.waitFor(() => expect(scrolled.length).toBe(1));
    expect(scrolled[0]).toContain('comment t3');
  });

  test('scrolls again when the thread already open is opened a second time', async () => {
    openThread('t2');
    await renderPanel();
    await vi.waitFor(() => expect(scrolled.length).toBe(1));

    act(() => openThread('t2'));

    await vi.waitFor(() => expect(scrolled.length).toBe(2));
    expect(scrolled[1]).toContain('comment t2');
  });

  test('rings the card it lands on, so the eye finds it in a long list', async () => {
    openThread('t2');
    await renderPanel();

    const card = (await screen.findByText('comment t2')).closest('article');
    expect(card?.className).toContain('ring-2');
  });

  test('stands down for a thread this scope does not list', async () => {
    openThread('t-elsewhere');
    await renderPanel();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrolled).toEqual([]);
  });
});
