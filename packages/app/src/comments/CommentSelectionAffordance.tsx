/**
 * Selection composer — where a comment is written.
 *
 * The "Comment" button in the selection toolbar (see CommentBubbleButton) opens
 * this composer on the current selection. Posting a comment adds it to the
 * project-wide QUEUE — it does NOT dispatch to an agent; the user batches
 * comments and dispatches them from the Comments tab, which this card offers a
 * route to. Living in the toolbar (rather than a second floating pill) means it
 * can't be occluded by the native formatting bar.
 *
 * The captured passage is marked in the DOCUMENT (see `setCommentDraftRange`)
 * rather than echoed back inside this card. Focus moving here drops the browser
 * selection, so without that mark a multi-line pick lost its end; with it, a
 * quote preview would be saying twice what the page already shows.
 *
 * Positioning follows the BubbleMenuBar recipe (posToDOMRect virtual element +
 * floating-ui autoUpdate/computePosition) anchored to the captured range so the
 * card stays put while you type. The middleware chain is this card's own, but
 * the region it clips and clamps against comes from the same producers the
 * formatting bar uses (editor/utils/editor-visible-region.ts) rather than a
 * second description of the pane. Rendered above the native bar (z-60).
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { commentQuoteText } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { posToDOMRect } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle,
} from '@/editor/ComposerMentionInput';
import {
  deriveEditorClipOptions,
  deriveEditorShiftOptions,
  SELECTION_SURFACE_GAP_PX,
} from '@/editor/utils/editor-visible-region';
import { getEditorView } from '@/editor/utils/get-editor-view';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { cn } from '@/lib/utils';
import { setCommentDraftRange } from './anchor-decorations';
import { captureSelectionContext } from './anchor-search';
import { useCommentsPanelOnScreen } from './comments-panel-visibility';
import { revealComments } from './reveal-queue';
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
  // Drives whether this card offers a route to the queue at all (see the row
  // below the field).
  const commentsOnScreen = useCommentsPanelOnScreen();
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
      // `commentQuoteText`, not `textBetween`: an inline atom (wiki link, tag,
      // image, inline math, footnote marker) and a promoted fence (mermaid,
      // math) both keep their reader-visible text in attributes, so plain
      // `textBetween` reads them as empty. Selecting one then produced no quote
      // at all, and selecting prose AROUND one produced a quote with a hole the
      // anchor resolver could not match.
      const quote = commentQuoteText(editor.state.doc, from, to).trim();
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
        middleware: [
          offset(SELECTION_SURFACE_GAP_PX),
          // A bare flip() clips against the viewport, which includes the
          // tab strip above the pane — so the card needs the region
          // boundary as well as the clamp that keeps it inside it.
          flip(deriveEditorClipOptions(editor)),
          shift(deriveEditorShiftOptions(editor)),
          // No hide(): unlike the formatting bar, this card holds a draft and
          // owns focus, so stamping `visibility: hidden` on it would drop the
          // caret to <body> mid-sentence. Scrolling the captured passage out
          // of the region parks the card at the region's edge instead, where
          // the draft stays reachable.
        ],
      })
        .then(({ x, y }) => {
          if (!floating.isConnected) return;
          floating.style.position = 'fixed';
          floating.style.left = `${x}px`;
          floating.style.top = `${y}px`;
        })
        .catch((error: unknown) => {
          // The region producers are evaluated inside this call, so a rejection
          // can originate here or in floating-ui. Keep the last good
          // coordinates rather than moving the card somewhere wrong, and say
          // why — a silent card that has stopped tracking its passage reads as
          // a positioning bug with no trail.
          if (floating.isConnected) {
            console.warn('[comments] composer computePosition failed', error);
          }
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
   * File the comment into the queue.
   *
   * There is no send-now twin. Writing a note and dispatching a batch are
   * separate decisions, and the dispatch belongs where the batch is visible —
   * the Comments tab — not behind a button on a card that shows one comment.
   */
  function post() {
    if (captured === null) return;
    // `getContent` renders each mention chip inline as its `@path`, so the
    // comment an agent reads names files the same way the chat composer does.
    const body = inputRef.current?.getContent().instruction.trim() ?? '';
    if (body.length === 0) return;
    // Posted straight into the queue by the store — no separate addToQueue.
    createThread({
      docName,
      quote: captured.quote,
      prefix: captured.prefix,
      suffix: captured.suffix,
      body,
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
      // Borrowed `PopoverContent` chrome rather than a real one: this follows a
      // ProseMirror text range through a floating-ui virtual element, and
      // Radix's anchor takes a DOM node.
      className="z-[60] flex w-80 flex-col gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md"
      style={{ position: 'fixed', top: 0, left: 0 }}
      data-testid="comment-composer"
    >
      {/* No dismiss button: Escape and a click anywhere outside both discard
          the draft (see `reset`'s two callers above), and a card this small
          spent a whole row saying so. */}
      {/* The chat composer's field, not a plain textarea — so `@` mentions a
          file here exactly as it does there, and the comment an agent receives
          carries real paths rather than a name it has to go find.

          Enter posts, with or without a modifier: there is one action now, so a
          modifier that reached a different one would be reaching for something
          that no longer exists. */}
      <ComposerMentionInput
        ref={inputRef}
        ariaLabel={t`Add a comment`}
        placeholder={t`Add a comment`}
        onEmptyChange={setEmpty}
        onSubmit={post}
        onEscape={reset}
        className="max-h-40 min-h-16 overflow-y-auto rounded-md border px-2 py-1 text-sm"
      />
      {/* Two different weights, deliberately: filing the comment is what this
          card is for, and the tab is where the batch already filed lives. The
          route out sits at the far end of the row so it reads as leaving rather
          than as a second way to post.

          The chord sits INLINE, not in a tooltip like the bubble bar — the field
          above has focus, so a hint you have to hover to find is a hint the
          keyboard user never sees. Bare glyph, NOT `Kbd`: its pill carries a
          height, min-width, padding and background, and it was reshaping the row
          it annotates. `normal-case tracking-normal` undoes the button's
          uppercase treatment for the glyph alone; the aria-label keeps it out of
          the accessible name. */}
      {/* `justify-end` when the route out is withheld, so the post button keeps
          the far end of the row it already sits at rather than sliding left into
          the space the missing button leaves. */}
      <div
        className={cn(
          'flex items-center gap-1.5',
          commentsOnScreen ? 'justify-end' : 'justify-between',
        )}
      >
        {/* Withheld while the queue is already on screen: the button's whole job
            is to take you there, and pressing it from in front of an open
            Comments tab changes nothing the eye can see. Dropping it also leaves
            the card with a single action while the panel is up. */}
        {commentsOnScreen ? null : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => revealComments('doc', docName)}
            className="px-2 text-muted-foreground hover:text-foreground"
          >
            <Trans>View comments</Trans>
          </Button>
        )}
        <Button size="sm" onClick={post} disabled={empty} aria-label={t`Add Comment (Enter)`}>
          <Trans>Add Comment</Trans>
          <span className="ml-0.5 text-[11px] tracking-normal normal-case text-primary-foreground/75">
            ⏎
          </span>
        </Button>
      </div>
    </div>,
    document.body,
  );
}
