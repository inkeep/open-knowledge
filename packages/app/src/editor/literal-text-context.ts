import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

export const RAW_SOURCE_NODE_TYPES: readonly string[] = ['jsxInline', 'rawMdxFallback'];

export function isCodeTextblock(node: PMNode): boolean {
  return node.type.spec.code === true;
}

export function rangeHasCodeMark(state: EditorState, from: number, to: number): boolean {
  const codeMark = state.schema.marks.code;
  if (!codeMark) return false;
  return state.doc.rangeHasMark(from, to, codeMark);
}

function isRawSourceNode(node: PMNode): boolean {
  return RAW_SOURCE_NODE_TYPES.includes(node.type.name);
}

export function isInLiteralTextContext(state: EditorState, from: number, to: number): boolean {
  const parent = state.doc.resolve(from).parent;
  if (isCodeTextblock(parent) || isRawSourceNode(parent)) return true;
  return rangeHasCodeMark(state, from, to);
}
