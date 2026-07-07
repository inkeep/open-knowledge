/**
 * "Footnote" button for the WYSIWYG bubble menu — demotes the current
 * inline selection into a footnote: the selected text MOVES to a new
 * `footnoteDefinition` block, joined to the existing footnote group at
 * doc end, and an inline `[^N]` `footnoteReference` atom replaces the
 * selection. N is the next free integer identifier across the doc's
 * existing definitions (`nextFootnoteIdentifier`), matching the slash-
 * menu `/footnote` auto-numbering rule so both entry points produce the
 * same identifier sequence.
 *
 * Authors can rename the identifier afterward via source-mode edit; the
 * markdown round-trip pairs reference→definition by `identifier` regardless.
 *
 * Selection contract — only fires when:
 *   - the selection is a non-empty TextSelection (inline content with
 *     visible text — the bubble menu's `shouldShowBubbleMenu` already
 *     gates on `textBetween(from, to).trim()`, so we inherit that)
 *   - the selection stays inside ONE textblock (`$from.sameParent($to)`)
 *     — `textBetween` flattens multi-paragraph selections into a single
 *     line, so a cross-block selection would silently lose paragraph
 *     structure when copied into the footnote definition body. Block-
 *     fidelity preserve would need a fragment slice rather than the flat
 *     text we currently pass — out of scope here; inline-only matches
 *     the JSDoc "inline content" contract.
 *   - the selection does not already contain a footnoteReference atom
 *     (the reference render is `<sup>[N]</sup>` — wrapping it again
 *     would nest `[^[^N]]` which round-trips as parse-broken GFM)
 *   - the doc schema actually has `footnoteReference` +
 *     `footnoteDefinition` registered (graceful no-op via disabled
 *     button if a stripped schema is in use, e.g. read-only preview
 *     surfaces)
 *
 * The button matches the icon-only bubble-menu convention (size="icon-xs",
 * onMouseDown+preventDefault to avoid the focus-flash that onClick would
 * cause, side="bottom"-anchored tooltip away from the page chrome above).
 */

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

/**
 * True iff the schema has both `footnoteReference` and `footnoteDefinition`
 * registered. Stripped schemas (e.g. read-only preview surfaces) may omit
 * them — gracefully render a disabled button rather than crash on dispatch.
 */
function hasFootnoteSchema(editor: Editor): boolean {
  const nodes = editor.schema.nodes;
  return Boolean(nodes.footnoteReference && nodes.footnoteDefinition);
}

/**
 * True iff the current selection spans (any subset of) an existing
 * `footnoteReference` atom. Wrapping a reference inside another reference
 * would emit `[^[^N]]` which parses back as broken GFM — block the action
 * rather than ship malformed markdown.
 */
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

/**
 * True iff the selection straddles two distinct textblocks (e.g. starts
 * in one paragraph and ends in another). `textBetween(from, to, ' ')`
 * collapses such selections into a single line, losing paragraph
 * structure on copy into the definition body. We disable instead of
 * lossy-copy — the user can re-select inside a single textblock or fall
 * back to the slash-menu insert for footnotes with multi-paragraph
 * bodies authored by hand.
 */
function selectionCrossesBlocks(editor: Editor): boolean {
  const { $from, $to } = editor.state.selection;
  return !$from.sameParent($to);
}

export function FootnoteBubbleButton({ editor }: { editor: Editor }): ReactNode {
  const { t } = useLingui();

  // Re-evaluate gating on every selection change so the disabled state
  // tracks the user's caret movement (e.g. clicking into a region that
  // contains a `[^N]` superscript should disable the button immediately).
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

    // Re-validate against LIVE editor state — `disabled` above closes over
    // the previous render's state, and `useEditorState` has a 250ms
    // updateDelay. A quick pointerdown after a same-tick selection change
    // could otherwise sneak past the React-state guard and produce the
    // `[^[^N]]` nesting bug the selectionContainsFootnoteRef gate exists
    // to prevent. The HTML `disabled` attribute catches the mouse path,
    // this catches the programmatic / keyboard-equivalent path.
    if (!hasFootnoteSchema(editor)) return;
    if (editor.state.selection.empty) return;
    if (selectionCrossesBlocks(editor)) return;
    if (selectionContainsFootnoteRef(editor)) return;

    // Capture the selected text BEFORE any chained dispatch — the
    // selection's `from`/`to` resolve against the current doc, and the
    // very next chain step (`deleteSelection`) shifts every later
    // position. Snapshotting plain text + boundaries here keeps the
    // chain self-contained.
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    if (!selectedText.trim()) return;

    // Allocate identifier from the doc's existing definitions — same
    // policy as `/footnote` slash command (see `slash-command/items.tsx`).
    const id = nextFootnoteIdentifier(collectFootnoteIdentifiers(editor.state.doc));

    // Single chain so a single Ctrl+Z undoes all three steps atomically:
    //   1. Delete the selection (text moves out of inline flow).
    //   2. Insert the `[^N]` footnoteReference atom where the selection
    //      was (nodeSize = 1).
    //   3. Insert a `[^N]: <selected text>` footnoteDefinition block —
    //      placed AFTER any existing `footnoteDefinition` blocks via the
    //      shared `findFootnoteDefinitionInsertPos` helper, so consecutive
    //      footnotes cluster without an empty paragraph slotted between
    //      them. Without that targeting, PM's per-insert trailing-paragraph
    //      behavior leaves a blank line between every pair of asides in
    //      both the WYSIWYG render AND the serialized markdown source.
    //
    // Position math for step 3's anchor. `insertContentAt(pos)` resolves
    // against the doc state at THIS chain step (post-delete + post-ref-
    // insert), not pre-chain. Predict the post-chain position by offsetting
    // the pre-chain helper result by the net change steps 1+2 will produce:
    //   delete:      -(to - from)
    //   insert ref:  +1                (footnoteReference is an inline atom)
    // The selection is always somewhere in prose, which is BEFORE the
    // helper's chosen position (end of last existing footnoteDefinition,
    // or doc end when none exist) — so both shifts apply to that anchor.
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
            // Stay consistent with sibling toolbar buttons (InlineFormatButtons,
            // LinkEditPopover): `mousedown` + `preventDefault` keeps DOM focus
            // on ProseMirror so the selection highlight stays painted while
            // the chain runs. Plain `onClick` lets the browser shift focus to
            // the button first, briefly hiding the selection.
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
