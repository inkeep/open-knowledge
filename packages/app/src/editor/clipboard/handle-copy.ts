/**
 * WYSIWYG copy/cut intercept — the OK→OK travel half of the
 * `data-clipboard-omit` contract.
 *
 * Every standard clipboard flavor is scrubbed of clipboard-omitted
 * content (comment annotations) at the serializers, so no public payload
 * can carry an annotation back into OK. When — and only when — the copied
 * slice contains omitted content, this handler owns the copy/cut event:
 *
 *   - `text/html` + `text/plain` via `view.serializeForClipboard(slice)`,
 *     which runs the editor's own `clipboardSerializer` /
 *     `clipboardTextSerializer` props (scrubbed output, `data-pm-slice`
 *     stamped by PM) — byte-identical to what PM's native handler would
 *     have written;
 *   - the UNSCRUBBED slice markdown on the private
 *     `application/x-openknowledge-markdown` flavor, which the paste
 *     dispatcher prefers, restoring the annotation on OK→OK paste.
 *
 * Selections with no omitted content decline the intercept (return
 * false) so PM's native copy path runs and behavior stays byte-identical
 * to before this handler existed. Comment-bearing CellSelection copies
 * are intercepted for the scrubbed public flavors only (a scrubbed-empty
 * TSV would otherwise be resurrected as raw bytes by the truthiness
 * fallbacks) but get NO private flavor: their payload belongs to the
 * table clipboard convention and prosemirror-tables' own cell-merge
 * paste handling — a private flavor there would reroute
 * table-into-table paste.
 *
 * Error-path discipline (matches serialize.ts): any throw declines the
 * intercept — PM's native handler still ships the scrubbed flavors, so a
 * failure here can lose OK→OK comment carriage but can never leak.
 */

import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { OK_INTERNAL_CLIPBOARD_MIME, sliceContainsClipboardOmitted } from './comment-scrub.ts';
import { logSerializeFail } from './instrument.ts';
import {
  createClipboardTextSerializer,
  sliceToDocJson,
  stripEnclosingMarkerWrappers,
} from './serialize.ts';

interface CopyCutHandlerDeps {
  mdManager: MarkdownManager;
}

export function createCopyCutHandler(deps: CopyCutHandlerDeps) {
  const serializeText = createClipboardTextSerializer(deps);
  return (view: EditorView, event: ClipboardEvent, isCut: boolean): boolean => {
    try {
      const { selection, schema } = view.state;
      if (selection.empty) return false;
      const data = event.clipboardData;
      if (!data) return false;
      const slice = selection.content();
      if (!sliceContainsClipboardOmitted(slice, schema)) return false;

      const { dom } = view.serializeForClipboard(slice);
      // Serialize text through our own scrubbed serializer, NOT via
      // serializeForClipboard's text or someProp: both treat an empty
      // string as "serializer declined" (truthiness fallback) and
      // substitute raw unscrubbed bytes — and empty IS the correct
      // payload for a comment-only copy.
      const text = serializeText(slice, view);

      event.preventDefault();
      data.clearData();
      data.setData('text/html', dom.innerHTML);
      data.setData('text/plain', text);

      if (!(selection instanceof CellSelection)) {
        // Match the pre-scrub text/plain carrier byte-for-byte (the payload
        // the paste dispatcher's markdown branch historically consumed):
        // peel partially-covered marker wrappers for interior text
        // selections, but keep the omitted content. CellSelections get NO
        // private flavor — their payload belongs to the table clipboard
        // convention and prosemirror-tables' cell-merge paste handling;
        // owning the event above still guarantees the scrubbed flavors
        // land instead of a truthiness-fallback resurrect.
        let internalSlice = slice;
        if (selection instanceof TextSelection) {
          internalSlice = stripEnclosingMarkerWrappers(slice, view.state);
        }
        const internalMarkdown = deps.mdManager.serialize(sliceToDocJson(internalSlice, schema));
        data.setData(OK_INTERNAL_CLIPBOARD_MIME, internalMarkdown);
      }

      if (isCut && view.editable) {
        view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
      }
      return true;
    } catch (err) {
      logSerializeFail({
        view: 'wysiwyg',
        kind: 'html',
        reason: `copy-intercept:${(err as Error)?.message ?? 'unknown'}`,
      });
      return false;
    }
  };
}
