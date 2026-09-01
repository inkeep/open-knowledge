import type { EditorState } from '@tiptap/pm/state';

export const CELL_NODES: ReadonlySet<string> = new Set(['tableCell', 'tableHeader']);

export function isSelectionInTableCell(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if (CELL_NODES.has($from.node(depth).type.name)) return true;
  }
  return false;
}
