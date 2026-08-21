import { autoUpdate, computePosition, flip, hide, offset, shift } from '@floating-ui/dom';
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

  // When an image / file is NodeSelected we swap the bar's contents to
  // per-type controls (alignment buttons for images, download for
  // files). The text-style controls (block-type / inline-format / link)
  // are inappropriate for a leaf media block — they'd target the wrong
  // selection or no-op. The selectors watch `selection` so the bar
  // swaps content live as the user moves between text and media blocks
  // without dismount.
  const isImageMode = useEditorState({
    editor,
    selector: (ctx) => isImageNodeSelected(ctx.editor),
  });
  const isFileMode = useEditorState({
    editor,
    selector: (ctx) => isFileNodeSelected(ctx.editor),
  });

  // Virtual element whose getBoundingClientRect always reflects the current
  // selection position. contextElement lets autoUpdate discover scroll ancestors
  // (including the overflow-y-auto editor container) automatically.
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

  // Clips placement to the editor's visible content region and hides the bar
  // when the selection scrolls behind the toolbar / bottom composer / footer —
  // see editor-visible-region.ts for why the viewport alone is the wrong boundary.
  const clipOptions = deriveEditorClipOptions(editor);
  // The clamp that keeps the bar inside that region. The boundary alone only
  // detects the overflow.
  const shiftOptions = deriveEditorShiftOptions(editor);

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
          hide(clipOptions),
        ],
      })
        .then(({ x, y, middlewareData }) => {
          if (popup.isConnected) {
            popup.style.position = 'fixed';
            popup.style.left = `${x}px`;
            popup.style.top = `${y}px`;
            // Hide rather than clamp once the selection is fully occluded — a
            // clamped bar floats over the footer/composer with no visible
            // selection anchoring it.
            popup.style.visibility = middlewareData.hide?.referenceHidden ? 'hidden' : 'visible';
          }
        })
        .catch((error: unknown) => {
          // computePosition is deferred third-party work, so teardown can win
          // the race. Live popups need a diagnostic; autoUpdate will retry.
          if (popup.isConnected) {
            console.warn('[bubble-menu] computePosition failed', error);
          }
        });
    });
  };

  const onHide = () => {
    stopAutoUpdateRef.current?.();
    stopAutoUpdateRef.current = null;
    // Bump key to force remount of tooltip-bearing children — prevents "rogue tooltips"
    // that stay open after the bubble menu hides due to portal/z-index timing.
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
      // flip/shift/hide mirror the autoUpdate loop above: the plugin runs its
      // own computePosition on editor transactions (remote CRDT edits
      // included), so both paths must agree on clipping, on the clamp that
      // keeps the bar inside the clip region, and on when the selection counts
      // as occluded — the plugin applies `referenceHidden` itself.
      //
      // `placement` and `offset` are stated rather than inherited from the
      // plugin's defaults because `pendingOffsetPx` below compensates for this
      // chain applying its gap AFTER the clamp — that compensation is only
      // correct while the gap matches the loop's, so both paths name it.
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
        hide: clipOptions,
      }}
      className="z-50 flex items-center gap-0.5 rounded-lg border bg-background p-1 shadow-md"
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
