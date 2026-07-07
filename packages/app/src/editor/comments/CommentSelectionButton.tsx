import { Trans } from '@lingui/react/macro';
import type { Editor } from '@tiptap/core';
import { MessageSquarePlus } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { serializeWysiwygSelection } from '@/editor/edit-with-ai-selection';
import { setPendingDocumentComment } from './comment-store';

interface ButtonPosition {
  readonly top: number;
  readonly left: number;
}

function selectionLineCount(markdown: string): number {
  return (markdown.match(/\n/g)?.length ?? 0) + 1;
}

function captureCommentAnchor(editor: Editor, docName: string) {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;

  const anchorText = editor.state.doc.textBetween(from, to, '\n');
  if (!anchorText.trim()) return null;

  const markdown = serializeWysiwygSelection(editor);
  const selectedMarkdown = markdown.trim() || anchorText.trim();
  const textStart = editor.state.doc.textBetween(0, from, '\n').length;
  return {
    docName,
    textStart,
    textEnd: textStart + anchorText.length,
    anchorText,
    markdown: selectedMarkdown,
    charLen: selectedMarkdown.length,
    lineCount: selectionLineCount(selectedMarkdown),
  };
}

export function CommentSelectionButton({
  editor,
  docName,
  activeDocName,
  isSourceMode,
}: {
  readonly editor: Editor;
  readonly docName: string;
  readonly activeDocName: string | null;
  readonly isSourceMode: boolean;
}): ReactNode {
  const [buttonPos, setButtonPos] = useState<ButtonPosition | null>(null);
  const activeRef = useRef({ docName, activeDocName, isSourceMode });
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    activeRef.current = { docName, activeDocName, isSourceMode };
  }, [docName, activeDocName, isSourceMode]);

  useEffect(() => {
    const updateButton = () => {
      const active = activeRef.current;
      if (active.isSourceMode || active.docName !== active.activeDocName) {
        setButtonPos(null);
        return;
      }
      const { selection } = editor.state;
      if (selection.empty) {
        setButtonPos(null);
        return;
      }
      const selectedText = editor.state.doc.textBetween(selection.from, selection.to, '\n');
      if (!selectedText.trim()) {
        setButtonPos(null);
        return;
      }

      const nativeSelection = window.getSelection();
      if (!nativeSelection || nativeSelection.rangeCount === 0) return;
      const range = nativeSelection.getRangeAt(0);
      if (!editor.view.dom.contains(range.commonAncestorContainer)) return;
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      setButtonPos({ top: rect.top - 8, left: rect.left });
    };

    const hideButton = () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => setButtonPos(null), 150);
    };

    editor.on('selectionUpdate', updateButton);
    editor.on('blur', hideButton);
    return () => {
      editor.off('selectionUpdate', updateButton);
      editor.off('blur', hideButton);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, [editor]);

  function handleAddComment() {
    const active = activeRef.current;
    if (active.isSourceMode || active.docName !== active.activeDocName) return;
    const anchor = captureCommentAnchor(editor, active.docName);
    if (!anchor) return;
    setPendingDocumentComment(anchor);
    requestDocPanelTab('comments');
    setButtonPos(null);
  }

  if (buttonPos === null) return null;

  return createPortal(
    <button
      type="button"
      data-testid="comment-selection-button"
      onMouseDown={(event) => {
        event.preventDefault();
        handleAddComment();
      }}
      className="fixed z-[60] inline-flex items-center gap-1.5 rounded-lg border border-border bg-popover px-2.5 py-1 text-foreground text-xs shadow-md transition-colors hover:bg-muted"
      style={{ left: buttonPos.left, top: buttonPos.top, transform: 'translateY(-100%)' }}
    >
      <MessageSquarePlus className="size-3.5" aria-hidden />
      <Trans>Comment</Trans>
    </button>,
    document.body,
  );
}
