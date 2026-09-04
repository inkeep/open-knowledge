// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
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
  deriveEditorSizeOptions,
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
  shortcutEnabled: boolean;
}) {
  const { t } = useLingui();
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [empty, setEmpty] = useState(true);
  const commentsOnScreen = useCommentsPanelOnScreen();
  const inputRef = useRef<ComposerMentionInputHandle>(null);
  const floatingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shortcutEnabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!matchesKeyboardShortcut(event, 'add-comment')) return;
      const target = event.target;
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (editor.state.selection.empty) return;
      event.preventDefault();
      emitStartComment();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcutEnabled, editor]);

  useEffect(() => {
    return subscribeStartComment(() => {
      const { selection } = editor.state;
      if (selection.empty) return;
      const { from, to } = selectedSpan(selection);
      if (to - from < 1) return;
      const quote = commentQuoteText(editor.state.doc, from, to).trim();
      if (quote.length === 0) return;
      const { prefix, suffix } = captureSelectionContext(editor.state.doc, from, to);
      setCaptured({ from, to, quote, prefix, suffix });
      setCommentDraftRange(editor, { from, to });
    });
  }, [editor]);

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
          flip(deriveEditorClipOptions(editor)),
          shift(deriveEditorShiftOptions(editor)),
          size(deriveEditorSizeOptions(editor)),
        ],
      })
        .then(({ x, y }) => {
          if (!floating.isConnected) return;
          floating.style.position = 'fixed';
          floating.style.left = `${x}px`;
          floating.style.top = `${y}px`;
        })
        .catch((error: unknown) => {
          if (floating.isConnected) {
            console.warn('[comments] composer computePosition failed', error);
          }
        });
    });
  }, [captured, editor]);

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

  useEffect(() => {
    if (captured === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      const card = floatingRef.current;
      if (card === null) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (card.contains(target)) return;
      if (target instanceof Element && target.closest('[data-suggestion-popup]') !== null) return;
      reset();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  });

  function post() {
    if (captured === null) return;
    const body = inputRef.current?.getContent().instruction.trim() ?? '';
    if (body.length === 0) return;
    createThread({
      docName,
      quote: captured.quote,
      prefix: captured.prefix,
      suffix: captured.suffix,
      body,
    });
    if (!editor.isDestroyed) {
      editor.commands.setTextSelection(Math.min(captured.to, editor.state.doc.content.size));
    }
    reset();
  }

  if (captured === null) return null;

  return createPortal(
    <div
      ref={floatingRef}
      className="z-[60] flex w-80 flex-col gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md"
      style={{ position: 'fixed', top: 0, left: 0 }}
      data-testid="comment-composer"
    >
      {}
      {}
      <ComposerMentionInput
        ref={inputRef}
        ariaLabel={t`Add a comment`}
        placeholder={t`Add a comment`}
        onEmptyChange={setEmpty}
        onSubmit={post}
        onEscape={reset}
        className="max-h-40 min-h-16 overflow-y-auto rounded-md border px-2 py-1 text-sm"
      />
      {}
      {}
      <div
        className={cn(
          'flex items-center gap-1.5',
          commentsOnScreen ? 'justify-end' : 'justify-between',
        )}
      >
        {}
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
