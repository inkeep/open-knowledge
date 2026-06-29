import {
  collectFootnoteIdentifiers,
  findFootnoteDefinitionInsertPos,
  nextFootnoteIdentifier,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { Superscript } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function hasFootnoteSchema(editor: Editor): boolean {
  const nodes = editor.schema.nodes;
  return Boolean(nodes.footnoteReference && nodes.footnoteDefinition);
}

function selectionContainsFootnoteRef(editor: Editor): boolean {
  const { from, to } = editor.state.selection;
  let found = false;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.type.name === 'footnoteReference') {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function selectionCrossesBlocks(editor: Editor): boolean {
  const { $from, $to } = editor.state.selection;
  return !$from.sameParent($to);
}

export function FootnoteBubbleButton({ editor }: { editor: Editor }): ReactNode {
  const { t } = useLingui();

  const disabled = useEditorState({
    editor,
    selector: (ctx) => {
      const ed = ctx.editor;
      if (!hasFootnoteSchema(ed)) return true;
      if (ed.state.selection.empty) return true;
      if (selectionCrossesBlocks(ed)) return true;
      if (selectionContainsFootnoteRef(ed)) return true;
      return false;
    },
  });

  const wrapSelection = (): void => {
    if (disabled) return;

    if (!hasFootnoteSchema(editor)) return;
    if (editor.state.selection.empty) return;
    if (selectionCrossesBlocks(editor)) return;
    if (selectionContainsFootnoteRef(editor)) return;

    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    if (!selectedText.trim()) return;

    const id = nextFootnoteIdentifier(collectFootnoteIdentifiers(editor.state.doc));

    const preChainInsertPos = findFootnoteDefinitionInsertPos(editor.state.doc);
    const insertAt = preChainInsertPos + 1 - (to - from);

    editor
      .chain()
      .focus()
      .deleteSelection()
      .insertFootnoteReference(id)
      .insertContentAt(insertAt, {
        type: 'footnoteDefinition',
        attrs: { identifier: id, label: id },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: selectedText }] }],
      })
      .run();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="footnote-bubble-button"
          className="text-accent-foreground/80"
          aria-label={t`Convert selection to footnote`}
          onMouseDown={(e) => {
            e.preventDefault();
            wrapSelection();
          }}
          disabled={disabled}
        >
          <Superscript className="size-3.5" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={8}
      >{t`Convert selection to footnote`}</TooltipContent>
    </Tooltip>
  );
}
