import type { NodeViewProps } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';

type JsxNodeTarget =
  | { kind: 'current' | 'changed'; pos: number; node: PmNode }
  | { kind: 'removed' };

export function resolveJsxNodeTarget(
  doc: PmNode,
  getPos: NodeViewProps['getPos'],
  expected: PmNode,
): JsxNodeTarget {
  const pos = getPos();
  if (pos === undefined) return { kind: 'removed' };
  const node = doc.nodeAt(pos);
  if (!node) return { kind: 'removed' };
  return { kind: node.eq(expected) ? 'current' : 'changed', pos, node };
}

export function isSameJsxElement(current: PmNode, expected: PmNode): boolean {
  return (
    current.type === expected.type &&
    current.attrs.kind === 'element' &&
    current.attrs.componentName === expected.attrs.componentName
  );
}
