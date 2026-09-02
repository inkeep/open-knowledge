import { GapCursor } from '@tiptap/pm/gapcursor';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';

export function insertParagraphAt(view: EditorView, pos: number): boolean {
  const paragraph = view.state.schema.nodes.paragraph?.create();
  if (!paragraph) return false;
  const tr = view.state.tr.insert(pos, paragraph);
  if (tr.doc.content.size === view.state.doc.content.size) return false;
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function moveCaretAfterNode(view: EditorView, pos: number, nodeSize: number): boolean {
  const { doc } = view.state;
  const forward = Selection.findFrom(doc.resolve(pos + nodeSize), 1, true);
  if (!forward) return false;
  view.dispatch(view.state.tr.setSelection(forward).scrollIntoView());
  return true;
}

export function placeGapCursorAfterNode(view: EditorView, pos: number, nodeSize: number): boolean {
  const { doc } = view.state;
  const $after = doc.resolve(pos + nodeSize);
  const probe = new GapCursor($after).map(doc, new Mapping());
  if (!(probe instanceof GapCursor)) return false;
  view.dispatch(view.state.tr.setSelection(probe).scrollIntoView());
  return true;
}
