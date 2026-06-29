'use client';

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { type Editor, posToDOMRect } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Bold, Code, Highlighter, Italic, Strikethrough, Underline } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { BlockTypeSelector } from './block-type-selector';

const FORMAT_ACTIONS = [
  {
    name: 'Bold',
    Icon: Bold,
    run: (e: Editor) => e.chain().focus().toggleBold().run(),
    mark: 'strong',
    shortcut: '⌘B',
  },
  {
    name: 'Italic',
    Icon: Italic,
    run: (e: Editor) => e.chain().focus().toggleItalic().run(),
    mark: 'emphasis',
    shortcut: '⌘I',
  },
  {
    name: 'Underline',
    Icon: Underline,
    run: (e: Editor) => e.chain().focus().toggleUnderline().run(),
    mark: 'underline',
    shortcut: '⌘U',
  },
  {
    name: 'Strikethrough',
    Icon: Strikethrough,
    run: (e: Editor) => e.chain().focus().toggleStrike().run(),
    mark: 'strike',
    shortcut: '⌘⇧S',
  },
  {
    name: 'Code',
    Icon: Code,
    run: (e: Editor) => e.chain().focus().toggleCode().run(),
    mark: 'code',
    shortcut: '⌘E',
  },
  {
    name: 'Highlight',
    Icon: Highlighter,
    run: (e: Editor) => e.chain().focus().toggleHighlight().run(),
    mark: 'highlight',
    shortcut: '⌘⇧H',
  },
] as const;

function shouldShow({ editor }: { editor: Editor }): boolean {
  if (!editor.isEditable) return false;
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;
  return Boolean(editor.state.doc.textBetween(from, to, ' ').trim());
}

export function OkBubbleMenu({ editor }: { editor: Editor }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const stopAutoUpdate = useRef<(() => void) | null>(null);

  useEffect(() => () => stopAutoUpdate.current?.(), []);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }): Record<string, boolean> =>
      Object.fromEntries(FORMAT_ACTIONS.map((a) => [a.mark, e.isActive(a.mark)])),
  });
  const inCodeBlock = useEditorState({
    editor,
    selector: ({ editor: e }) => e.isActive('codeBlock'),
  });

  let contextElement: Element | undefined;
  try {
    contextElement = editor.view.dom;
  } catch {
    contextElement = undefined;
  }

  const anchor = {
    getBoundingClientRect: () => {
      try {
        const { from, to } = editor.state.selection;
        return posToDOMRect(editor.view, from, to);
      } catch {
        return new DOMRect();
      }
    },
    contextElement,
  };

  const onShow = () => {
    const popup = menuRef.current;
    if (!popup) return;
    stopAutoUpdate.current?.();
    stopAutoUpdate.current = autoUpdate(anchor, popup, () => {
      computePosition(anchor, popup, {
        placement: 'top',
        strategy: 'fixed',
        middleware: [offset(8), flip(), shift({ padding: 8 })],
      })
        .then(({ x, y }) => {
          if (!popup.isConnected) return;
          popup.style.position = 'fixed';
          popup.style.left = `${x}px`;
          popup.style.top = `${y}px`;
        })
        .catch(() => {
        });
    });
  };

  const onHide = () => {
    stopAutoUpdate.current?.();
    stopAutoUpdate.current = null;
  };

  return (
    <BubbleMenu
      ref={menuRef}
      editor={editor}
      shouldShow={shouldShow}
      updateDelay={200}
      appendTo={() => document.body}
      options={{ onShow, onHide, strategy: 'fixed' }}
      className="ok-bubble-menu"
    >
      <BlockTypeSelector editor={editor} />
      {/* Marks don't apply in code blocks — show only the block-type dropdown
          there (so the block can still be converted back to text). */}
      {!inCodeBlock && <span className="ok-bubble-sep" aria-hidden="true" />}
      {/* delayDuration 0 (the shadcn default) feels twitchy in a dense toolbar;
          a short delay reads as intentional hover. */}
      {!inCodeBlock && (
        <TooltipProvider delayDuration={350}>
          {FORMAT_ACTIONS.map(({ name, Icon, run, mark, shortcut }) => (
            <Tooltip key={name}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={name}
                  aria-pressed={active[mark]}
                  className={cn('ok-bubble-btn', active[mark] && 'is-active')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(editor);
                  }}
                >
                  <Icon className="ok-bubble-icon" />
                </button>
              </TooltipTrigger>
              <TooltipContent sideOffset={8} className="flex items-center gap-1.5">
                {name}
                <span className="text-[11px] text-slide-bg/60">{shortcut}</span>
              </TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
      )}
    </BubbleMenu>
  );
}
