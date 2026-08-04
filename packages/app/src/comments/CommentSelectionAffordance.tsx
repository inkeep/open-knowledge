/**
 * Selection composer — where a comment is written.
 *
 * The "Comment" button in the selection toolbar (next to "Ask AI", see
 * CommentBubbleButton) opens this composer on the current selection. Posting a
 * comment adds it to the project-wide QUEUE — it does NOT dispatch to an
 * agent immediately; the user batches comments and dispatches the queue in one
 * action. Living in the toolbar (rather than a second floating pill) means it
 * can't be occluded by the native formatting bar.
 *
 * The captured passage is marked in the DOCUMENT (see `setCommentDraftRange`)
 * rather than echoed back inside this card. Focus moving here drops the browser
 * selection, so without that mark a multi-line pick lost its end; with it, a
 * quote preview would be saying twice what the page already shows.
 *
 * Positioning clones the BubbleMenuBar recipe (posToDOMRect virtual element +
 * floating-ui autoUpdate/computePosition) anchored to the captured range so the
 * card stays put while you type. Rendered above the native bar (z-60).
 */

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Trans, useLingui } from '@lingui/react/macro';
import { posToDOMRect } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle,
} from '@/editor/ComposerMentionInput';
import { getEditorView } from '@/editor/utils/get-editor-view';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { setCommentDraftRange } from './anchor-decorations';
import { captureSelectionContext } from './anchor-search';
import { appendQueueToOpenSession } from './append-to-open-session';
import { selectedSpan } from './selected-span';
import { createThread, emitStartComment, subscribeStartComment } from './store';

interface Captured {
  from: number;
  to: number;
  quote: string;
  /** Rendered text either side of the pick — says which occurrence, when the quote repeats. */
  prefix: string;
  suffix: string;
}

export function CommentSelectionAffordance({
  editor,
  docName,
  shortcutEnabled,
}: {
  editor: Editor;
  docName: string;
  /** Only the foreground document answers the keyboard shortcut. */
  shortcutEnabled: boolean;
}) {
  const { t } = useLingui();
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [empty, setEmpty] = useState(true);
  const inputRef = useRef<ComposerMentionInputHandle>(null);
  const floatingRef = useRef<HTMLDivElement>(null);

  // The keyboard route to the same intent the toolbar button emits. Lives here
  // rather than on the button: the bubble menu only mounts while its own
  // selection UI is showing, whereas this component is mounted for the editor's
  // whole life, so the chord works the moment there is a selection.
  useEffect(() => {
    if (!shortcutEnabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!matchesKeyboardShortcut(event, 'add-comment')) return;
      // A caret in a real form field (rename box, search) keeps its own keys.
      const target = event.target;
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (editor.state.selection.empty) return;
      event.preventDefault();
      emitStartComment();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcutEnabled, editor]);

  // Open the composer when the toolbar "Comment" button fires — capturing the
  // live selection at that moment (no continuous tracking needed).
  useEffect(() => {
    return subscribeStartComment(() => {
      const { selection } = editor.state;
      if (selection.empty) return;
      const { from, to } = selectedSpan(selection);
      if (to - from < 1) return;
      // The rendered text, deliberately — NOT the selection serialized back to
      // markdown. A serialized partial selection carries the block marker of
      // whatever block it sits in, so picking mid-bullet yields
      // "- 3 tbsp peanut butter" for a source line reading
      // "- **Peanut sauce:** 3 tbsp peanut butter" — a quote that is in no
      // document. The server matches rendered text against the markdown body
      // with syntax treated as elastic, so the plain text is what it wants.
      const quote = editor.state.doc.textBetween(from, to, '\n').trim();
      if (quote.length === 0) return;
      // Captured HERE, at the moment of the pick — this component is the only
      // place that knows which occurrence of a repeated passage was selected.
      const { prefix, suffix } = captureSelectionContext(editor.state.doc, from, to);
      setCaptured({ from, to, quote, prefix, suffix });
      // Focus moves into the composer, which drops the browser selection. Mark
      // the passage instead, so it stays visibly picked while you type.
      setCommentDraftRange(editor, { from, to });
    });
  }, [editor]);

  // Keep the floating card pinned to the captured range across scroll/layout.
  useEffect(() => {
    if (captured === null) return;
    const floating = floatingRef.current;
    if (!floating) return;
    const view = getEditorView(editor);
    if (!view) return;
    const virtualEl = {
      getBoundingClientRect: () => {
        try {
          return posToDOMRect(view, captured.from, captured.to);
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
  }, [captured, editor]);

  // The mention field is an editor, not an input, so there is no `autoFocus` to
  // set — focus is a method call once it has mounted for this capture.
  useEffect(() => {
    if (captured === null) return;
    inputRef.current?.focus();
  }, [captured]);

  function reset() {
    inputRef.current?.clear();
    setEmpty(true);
    setCaptured(null);
    setCommentDraftRange(editor, null);
  }

  /**
   * A click anywhere else discards the draft.
   *
   * Pointer-DOWN rather than click, so the composer is gone before the click
   * lands — otherwise pressing a toolbar button would act on a selection the
   * composer was still holding. Capture phase for the same reason: handlers that
   * stop propagation (the bubble menu's own) must not be able to keep it open.
   *
   * Escape does the same thing from the keyboard; this is the pointer twin, and
   * both route through `reset` so a dismissed draft always clears the document's
   * draft mark with it.
   */
  useEffect(() => {
    if (captured === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      const card = floatingRef.current;
      if (card === null) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (card.contains(target)) return;
      // The `@`-mention results are portaled to `document.body`, so they are
      // outside the card by DOM but not by intent — picking a file must not read
      // as clicking away.
      if (target instanceof Element && target.closest('[data-suggestion-popup]') !== null) return;
      reset();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  });

  /**
   * File the comment. `dispatch` decides which of the two buttons ran it:
   * queue it for a later batch, or hand it to an agent now.
   *
   * Both write the same thread — sending is not a different KIND of comment,
   * just a comment that does not wait. That is why one function takes a flag
   * rather than there being two creation paths to keep in step.
   */
  function post(dispatch: boolean) {
    if (captured === null) return;
    // `getContent` renders each mention chip inline as its `@path`, so the
    // comment an agent reads names files the same way the Ask AI composer does.
    const body = inputRef.current?.getContent().instruction.trim() ?? '';
    if (body.length === 0) return;
    // Posted straight into the queue by the store — no separate addToQueue.
    createThread({
      docName,
      quote: captured.quote,
      prefix: captured.prefix,
      suffix: captured.suffix,
      body,
      // Reuse-or-launch is the same decision the queue's own send makes, and it
      // is made by the sessions dock, not here: a live chat takes the comment,
      // and with none open one starts. Deliberately NOT the `deliver` hook the
      // queue batch uses — that is only installed while the Comments tab is
      // mounted, so a send from the editor with the panel closed did nothing.
      onCreated: dispatch
        ? (threadId) => {
            // `resolve` so it does not also land in the queue: this was a send,
            // not a review item filed for later, and leaving it open would mean
            // the reviewer's next batch carried the same note a second time.
            void appendQueueToOpenSession({
              threadIds: [threadId],
              submit: true,
              resolve: true,
            });
          }
        : undefined,
    });
    // Collapse the picked range: the passage has been filed, so it is no longer
    // "selected for whatever you do next". Left selected it re-pins itself in
    // the composer the moment anything re-reads the editor selection.
    if (!editor.isDestroyed) {
      editor.commands.setTextSelection(Math.min(captured.to, editor.state.doc.content.size));
    }
    reset();
  }

  if (captured === null) return null;

  return createPortal(
    <div
      ref={floatingRef}
      className="z-[60] flex w-80 flex-col gap-2 rounded-lg border bg-popover p-3 shadow-lg"
      style={{ position: 'fixed', top: 0, left: 0 }}
      data-testid="comment-composer"
    >
      {/* Dismiss sits in the corner rather than the action row: the row is for
          the two things that FILE the comment, and a third button beside them
          made discarding look like a peer of sending.

          Its own row rather than absolute positioning — overlaying the card
          floated it on top of the textarea's rounded corner, and any offset that
          clears the corner is a magic number that breaks the moment the field's
          radius or padding changes. A row cannot overlap by construction; the
          negative margins only pull it tight into the corner. */}
      <div className="-mt-1 -mr-1 -mb-1 flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t`Discard this comment`}
          onClick={reset}
          className="size-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {/* The Ask AI composer's field, not a plain textarea — so `@` mentions a
          file here exactly as it does there, and the comment an agent receives
          carries real paths rather than a name it has to go find.

          Enter files the comment. Sending is a click: the field cannot tell this
          host whether a modifier was held (Enter and ⌘Enter reach `onSubmit`
          identically), so a keyboard shortcut for the irreversible action would
          have to be guessed at. */}
      <ComposerMentionInput
        ref={inputRef}
        ariaLabel={t`Add a comment`}
        placeholder={t`Add a comment`}
        onEmptyChange={setEmpty}
        onSubmit={() => post(false)}
        onEscape={reset}
        className="max-h-40 min-h-16 overflow-y-auto rounded-md border px-2 py-1 text-sm"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="outline" onClick={() => post(false)} disabled={empty}>
          <Trans>Add Comment</Trans>
        </Button>
        <Button size="sm" onClick={() => post(true)} disabled={empty}>
          <Trans>Send to AI</Trans>
        </Button>
      </div>
    </div>,
    document.body,
  );
}
