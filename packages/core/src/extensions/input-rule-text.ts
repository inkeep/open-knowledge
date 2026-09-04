import type { Node as PMNode } from '@tiptap/pm/model';

export const INLINE_OBJECT_PLACEHOLDER = '\uFFFC';

export function renderInlineObjectText({ node }: { node: PMNode }): string {
  return INLINE_OBJECT_PLACEHOLDER.repeat(node.nodeSize - node.content.size);
}
