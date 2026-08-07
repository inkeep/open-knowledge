/**
 * In-doc thread popover.
 *
 * Clicking a highlighted passage (or its margin dot) pops the thread up as a
 * floating card anchored to the text — the Google-Docs / Notion gesture — rather
 * than opening the side panel. Reuses the panel's `ThreadCard`, so edit, queue,
 * and resolve behave identically in both places, and the BubbleMenuBar floating
 * recipe for positioning.
 *
 * Only open threads are anchored in the doc, so the popover auto-closes when its
 * thread resolves (its highlight disappears) or is removed.
 */

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { posToDOMRect } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getEditorView } from '@/editor/utils/get-editor-view';
import { findQuoteRange } from './anchor-search';
import { propertyRowRect } from './property-row-rect';
import {
  emitOpenThreadPopover,
  subscribeOpenThreadPopover,
  useCommentThreads,
  useQueueSelection,
} from './store';
import { ThreadCard } from './ThreadCard';

export function CommentThreadPopover({ editor, docName }: { editor: Editor; docName: string }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const floatingRef = useRef<HTMLDivElement>(null);
  const threads = useCommentThreads(docName);
  const thread = threadId ? (threads.find((t) => t.id === threadId) ?? null) : null;
  // The card's tick is a controlled checkbox, so this popover has to subscribe
  // to the send list the same way the panels do. Without it the box rendered
  // from `undefined` — permanently unchecked, however many times you clicked it,
  // while the click itself went through to the store. The state was right and
  // only this view disagreed, which is the worst shape a bug like this can take.
  const sending = useQueueSelection();

  // Open on highlight/marker click.
  useEffect(() => {
    return subscribeOpenThreadPopover((id) => setThreadId(id));
  }, []);

  // Auto-close when the thread is gone or no longer anchored (resolved/orphaned).
  // Announced rather than set locally: the margin rail mirrors this state and
  // would otherwise keep the marker lit for a popover that closed itself.
  useEffect(() => {
    if (threadId !== null && (thread === null || thread.status !== 'open')) {
      emitOpenThreadPopover(null);
    }
  }, [threadId, thread]);

  // Pin the card to the anchored text.
  useEffect(() => {
    if (thread === null) return;
    const floating = floatingRef.current;
    if (!floating) return;
    const view = getEditorView(editor);
    if (!view) return;
    // Two rect sources, one positioner. A passage measures through ProseMirror;
    // a property measures its row in the properties table, which sits in the
    // same scroll container. Resolved live inside `getBoundingClientRect` rather
    // than captured once, so `autoUpdate` keeps following the target as the
    // reader scrolls or the row reflows.
    const propertyKey = thread.target.kind === 'property' ? thread.target.key : null;
    const range =
      propertyKey === null && thread.anchor !== null
        ? findQuoteRange(editor.state.doc, thread.anchor.quote, thread.anchor)
        : null;
    if (propertyKey === null && range === null) return;
    const virtualEl = {
      getBoundingClientRect: () => {
        if (propertyKey !== null) return propertyRowRect(propertyKey) ?? new DOMRect();
        if (range === null) return new DOMRect();
        try {
          return posToDOMRect(view, range.from, range.to);
        } catch {
          return new DOMRect();
        }
      },
      contextElement: view.dom,
    };
    return autoUpdate(virtualEl, floating, () => {
      computePosition(virtualEl, floating, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [offset(8), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        floating.style.position = 'fixed';
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
      });
    });
  }, [thread, editor]);

  // Dismiss on outside click / Escape. Clicks on a highlight or a rail marker
  // are ignored here — both carry `data-comment-thread` and drive this popover
  // through the bus, so letting mousedown close first would make a marker's
  // toggle-to-close immediately reopen.
  useEffect(() => {
    if (thread === null) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (floatingRef.current?.contains(target)) return;
      if (target?.closest('[data-comment-thread]')) return;
      emitOpenThreadPopover(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') emitOpenThreadPopover(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [thread]);

  if (thread === null) return null;

  return createPortal(
    <div
      ref={floatingRef}
      className="z-50 w-80 rounded-lg bg-popover shadow-lg"
      style={{ position: 'fixed', top: 0, left: 0 }}
    >
      <ThreadCard
        thread={thread}
        now={now}
        focused={false}
        sending={sending.includes(thread.id)}
        cardRef={() => {}}
        onClose={() => emitOpenThreadPopover(null)}
      />
    </div>,
    document.body,
  );
}
