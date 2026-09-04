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
      const text = serializeText(slice, view);

      event.preventDefault();
      data.clearData();
      data.setData('text/html', dom.innerHTML);
      data.setData('text/plain', text);

      if (!(selection instanceof CellSelection)) {
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
