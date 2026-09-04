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
