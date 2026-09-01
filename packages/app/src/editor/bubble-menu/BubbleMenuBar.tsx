import { autoUpdate, computePosition, flip, hide, offset, shift, size } from '@floating-ui/dom';
import { posToDOMRect } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useRef, useState } from 'react';
import { CommentBubbleButton } from '@/comments/CommentBubbleButton';
import { Separator } from '@/components/ui/separator';
import {
  deriveEditorClipOptions,
  deriveEditorShiftOptions,
  deriveEditorSizeOptions,
  SELECTION_SURFACE_GAP_PX,
} from '../utils/editor-visible-region';
import { BlockTypeSelector } from './BlockTypeSelector';
import { shouldShowBubbleMenu } from './bubble-menu-state';
import { FileBubbleButtons, isFileNodeSelected } from './FileBubbleButtons';
import { FootnoteBubbleButton } from './FootnoteBubbleButton';
import { ImageAlignButtons, isImageNodeSelected } from './ImageAlignButtons';
import { InlineFormatButtons } from './InlineFormatButtons';
import { LinkEditPopover } from './LinkEditPopover';
import { ViewInSourceBubbleButton } from './ViewInSourceBubbleButton';

export function BubbleMenuBar({
  editor,
  shortcutEnabled = true,
}: {
  editor: Editor;
  shortcutEnabled?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [tooltipKey, setTooltipKey] = useState(0);
  const stopAutoUpdateRef = useRef<(() => void) | null>(null);

  const isImageMode = useEditorState({
    editor,
    selector: (ctx) => isImageNodeSelected(ctx.editor),
  });
  const isFileMode = useEditorState({
    editor,
    selector: (ctx) => isFileNodeSelected(ctx.editor),
  });

  const virtualEl = {
    getBoundingClientRect: () => {
      try {
        const { from, to } = editor.state.selection;
        return posToDOMRect(editor.view, from, to);
      } catch {
        return new DOMRect();
      }
    },
    contextElement: editor.view.dom,
  };

  const clipOptions = deriveEditorClipOptions(editor);
  const shiftOptions = deriveEditorShiftOptions(editor);
  const sizeOptions = deriveEditorSizeOptions(editor);

  const onShow = () => {
    const popup = menuRef.current;
    if (!popup) return;
    stopAutoUpdateRef.current?.();
    stopAutoUpdateRef.current = autoUpdate(virtualEl, popup, () => {
      computePosition(virtualEl, popup, {
        placement: 'top',
        strategy: 'fixed',
        middleware: [
          offset(SELECTION_SURFACE_GAP_PX),
          flip(clipOptions),
          shift(shiftOptions),
          size(sizeOptions),
          hide(clipOptions),
        ],
      })
        .then(({ x, y, middlewareData }) => {
          if (popup.isConnected) {
            popup.style.position = 'fixed';
            popup.style.left = `${x}px`;
            popup.style.top = `${y}px`;
            popup.style.visibility = middlewareData.hide?.referenceHidden ? 'hidden' : 'visible';
          }
        })
        .catch((error: unknown) => {
          if (popup.isConnected) {
            console.warn('[bubble-menu] computePosition failed', error);
          }
        });
    });
  };

  const onHide = () => {
    stopAutoUpdateRef.current?.();
    stopAutoUpdateRef.current = null;
    setTooltipKey((k) => k + 1);
  };

  return (
    <BubbleMenu
      ref={menuRef}
      editor={editor}
      data-testid="bubble-menu-bar"
      appendTo={() => document.body}
      shouldShow={shouldShowBubbleMenu}
      updateDelay={250}
      options={{
        onShow,
        onHide,
        strategy: 'fixed',
        placement: 'top',
        offset: SELECTION_SURFACE_GAP_PX,
        flip: clipOptions,
        shift: deriveEditorShiftOptions(editor, {
          pendingOffsetPx: SELECTION_SURFACE_GAP_PX,
        }),
        size: sizeOptions,
        hide: clipOptions,
      }}
      className="z-50 flex flex-wrap items-center gap-0.5 rounded-lg border bg-background p-1 shadow-md"
    >
      {isImageMode ? (
        <ImageAlignButtons key={`${tooltipKey}-img-align`} editor={editor} />
      ) : isFileMode ? (
        <FileBubbleButtons key={`${tooltipKey}-file`} editor={editor} />
      ) : (
        <>
          <BlockTypeSelector editor={editor} />
          <Separator orientation="vertical" className="mx-0.5 h-5 data-vertical:self-center" />
          <InlineFormatButtons key={tooltipKey} editor={editor} />
          <Separator orientation="vertical" className="mx-0.5 h-5 data-vertical:self-center" />
          <LinkEditPopover
            key={`${tooltipKey}-link`}
            editor={editor}
            shortcutEnabled={shortcutEnabled}
          />
          <FootnoteBubbleButton key={`${tooltipKey}-footnote`} editor={editor} />
          <ViewInSourceBubbleButton key={`${tooltipKey}-view-source`} editor={editor} />
          <CommentBubbleButton key={`${tooltipKey}-comment`} />
        </>
      )}
    </BubbleMenu>
  );
}
