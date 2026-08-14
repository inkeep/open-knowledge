/**
 * Opening a thread brings its card up in the panel.
 *
 * The comment used to be shown twice: a floating card pinned over the passage
 * AND the same comment in the panel. The floating one covered the document at
 * the moment the reader was trying to read it, so it is gone — which makes the
 * panel the only place a comment is read, and makes "the card is in the list
 * somewhere" not good enough. The card has to be IN VIEW.
 *
 * The awkward half is the ordering: opening a thread is what switches the doc
 * panel to the Comments tab, so this panel is usually MOUNTED BY the open it
 * has to answer and can never hear the signal that caused it. Reading the open
 * thread as state rather than as an event is what covers that, and the first
 * test is the one that would fail if it went back to a subscription.
 */

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

/** The open thread, as the store holds it: state with a signal over it. */
let openThreadId: string | null = null;
const snapshotListeners = new Set<() => void>();
const openListeners = new Set<(id: string | null) => void>();

/**
 * The real `emitOpenThread`, doubled: write the state, then announce it —
 * ALWAYS, including when the id has not changed. That last part is what the
 * repeat-open case turns on, so the double would hide the bug if it deduped.
 */
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

// The footer drags in the agent picker and the sessions dock; neither is what
// these tests are about.
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

/** Which card each `scrollIntoView` was called on, by the comment it carries. */
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
  // jsdom has no layout, so `scrollIntoView` is not implemented — the double is
  // both the stand-in and the probe. On `HTMLElement`, where the jsdom preload
  // puts its own no-op stub: patched one level up on `Element` instead, that
  // stub shadows this and every card scrolls silently past the probe.
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
    // The real order: a highlight click opens the thread, which switches the
    // doc panel to this tab, which mounts this panel.
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
    // Scroll the panel away from the card, click the same highlight to come
    // back: the id has not moved, so nothing about the panel's STATE changed
    // and a state-driven scroll bails out with the render — a click that does
    // nothing at all. The ring is gone by then too, so there is not even a
    // trace of the card left to follow.
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
    // This-doc lists one file; the queue spans the project, so the open thread
    // can be a comment on a document this panel is not showing.
    openThread('t-elsewhere');
    await renderPanel();

    // Deliberately given time to be wrong: the scroll is chased across frames,
    // so an assertion on the next tick alone would pass whatever it did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrolled).toEqual([]);
  });
});
