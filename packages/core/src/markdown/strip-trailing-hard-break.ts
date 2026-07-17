import type { Nodes, Parent, RootContent } from 'mdast';

const MARK_WRAPPERS = new Set(['strong', 'emphasis', 'delete', 'link', 'mark', 'comment']);

function isBareTrailingBreak(node: RootContent | undefined): boolean {
  if (!node || node.type !== 'break') return false;
  const sourceRaw = (node.data as { sourceRaw?: unknown } | undefined)?.sourceRaw;
  return typeof sourceRaw !== 'string' || sourceRaw.length === 0;
}

/** Remove trailing bare breaks from a phrasing-children array, recursing into
 * trailing mark wrappers and pruning any wrapper the removal empties. */
function stripTrailing(children: RootContent[]): void {
  while (children.length > 0) {
    const last = children[children.length - 1];
    if (isBareTrailingBreak(last)) {
      children.pop();
      continue;
    }
    if (last && MARK_WRAPPERS.has(last.type) && 'children' in last) {
      const inner = (last as Parent).children as RootContent[];
      stripTrailing(inner);
      if (inner.length === 0) {
        children.pop();
        continue;
      }
    }
    break;
  }
}

const BLOCK_CONTAINERS = new Set(['paragraph', 'heading', 'tableCell']);

/** In-place: strip trailing editor-created hard breaks from every block whose
 * phrasing content can end in one. */
export function stripTrailingHardBreaks(tree: Nodes): void {
  const visit = (node: Nodes): void => {
    if (BLOCK_CONTAINERS.has(node.type) && 'children' in node) {
      stripTrailing((node as Parent).children as RootContent[]);
    }
    if ('children' in node) {
      for (const child of (node as Parent).children as Nodes[]) visit(child);
    }
  };
  visit(tree);
}
