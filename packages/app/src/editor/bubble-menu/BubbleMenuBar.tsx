import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { posToDOMRect } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useRef, useState } from 'react';
import { Separator } from '@/components/ui/separator';
import { getFindReplaceState } from '../find-replace/tiptap-find-replace-extension';
import { BlockTypeSelector } from './BlockTypeSelector';
import { EditWithAiBubbleButton } from './EditWithAiBubbleButton';
import { FileBubbleButtons, isFileNodeSelected } from './FileBubbleButtons';
import { FootnoteBubbleButton } from './FootnoteBubbleButton';
import { ImageAlignButtons, isImageNodeSelected } from './ImageAlignButtons';
import { InlineFormatButtons } from './InlineFormatButtons';
import { LinkEditPopover } from './LinkEditPopover';

function shouldShowBubbleMenu({ editor }: { editor: Editor }): boolean {
  if (getFindReplaceState(editor.state).query) return false;
  if (editor.isActive('codeBlock')) return false;
  // Image / File NodeSelection — show the menu so the per-type buttons
  // (`ImageAlignButtons` / `FileBubbleButtons`) are reachable even though
  // `textBetween` is empty across a leaf atom. Bypasses the text-bearing-
  // selection guards below.
  if (isImageNodeSelected(editor)) return true;
  if (isFileNodeSelected(editor)) return true;
  if (editor.state.selection.empty) return false;
  const { from, to } = editor.state.selection;
  const text = editor.state.doc.textBetween(from, to, ' ');
  if (!text.trim()) return false;
  return true;
}

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

  const onShow = () => {
    const popup = menuRef.current;
    if (!popup) return;
    stopAutoUpdateRef.current?.();
    stopAutoUpdateRef.current = autoUpdate(virtualEl, popup, () => {
      computePosition(virtualEl, popup, {
        placement: 'top',
        strategy: 'fixed',
        middleware: [offset(8), flip(), shift({ padding: 8 })],
      })
        .then(({ x, y }) => {
          if (popup.isConnected) {
            popup.style.position = 'fixed';
            popup.style.left = `${x}px`;
            popup.style.top = `${y}px`;
          }
        })
        .catch(() => {
          // Position calculation failed (e.g., detached element) — autoUpdate will retry
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
      options={{ onShow, onHide, strategy: 'fixed' }}
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
          <LinkEditPopover key={`${tooltipKey}-link`} editor={editor} />
          <FootnoteBubbleButton key={`${tooltipKey}-footnote`} editor={editor} />
          <EditWithAiBubbleButton
            key={`${tooltipKey}-edit-ai`}
            editor={editor}
            shortcutEnabled={shortcutEnabled}
          />
        </>
      )}
    </BubbleMenu>
  );
}
