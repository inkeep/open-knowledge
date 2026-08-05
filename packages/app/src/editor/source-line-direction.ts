/**
 * Per-line writing direction for the markdown source editor.
 *
 * Markdown source is the user's own text, so each line has to read in the
 * direction it was written rather than in the interface language's. `direction`
 * inherits from the document element, so without this a right-to-left interface
 * would re-order an English line and a left-to-right one would flatten an Arabic
 * line.
 *
 * Two halves, and neither works alone. `dir="auto"` on each line element is what
 * resolves the direction from the line's own first strong character.
 * `perLineTextDirection` is what makes CodeMirror ask each line instead of
 * assuming one direction for the whole editor — it reads the direction back off
 * the rendered line, so the caret and selection land where the glyphs actually
 * are. Setting the attribute without the facet moves the text out from under the
 * cursor; enabling the facet without the attribute changes nothing, because
 * every line still reports the inherited direction.
 *
 * Decorations are rebuilt from the visible ranges only, so cost tracks the
 * viewport rather than the document.
 */

import type { Extension } from '@codemirror/state';
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

const directionFromContent = Decoration.line({ attributes: { dir: 'auto' } });

function buildLineDirections(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = view.state.doc.lineAt(pos);
      builder.add(line.from, line.from, directionFromContent);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const perLineDirectionPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildLineDirections(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildLineDirections(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const sourceLineDirection: Extension = [
  EditorView.perLineTextDirection.of(true),
  perLineDirectionPlugin,
];
