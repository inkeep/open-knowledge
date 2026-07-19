import type { Nodes, Parent, RootContent, Text } from 'mdast';

const MARK_WRAPPERS = new Set(['strong', 'emphasis', 'delete', 'link', 'mark', 'comment']);

function isBareTrailingBreak(node: RootContent | undefined): boolean {
  if (!node || node.type !== 'break') return false;
  const sourceRaw = (node.data as { sourceRaw?: unknown } | undefined)?.sourceRaw;
  return typeof sourceRaw !== 'string' || sourceRaw.length === 0;
}

/** True for a plain text node whose bytes are its visible value — no stored
 * sourceRaw provenance that re-emits different bytes. */
function isPlainText(node: RootContent | undefined): node is Text {
  if (!node || node.type !== 'text') return false;
  const sourceRaw = (node.data as { sourceRaw?: unknown } | undefined)?.sourceRaw;
  return typeof sourceRaw !== 'string' || sourceRaw.length === 0;
}

const TRAILING_INSIGNIFICANT_WS = /[ \t]+$/;
const WS_ONLY = /^[ \t]*$/;

/** True when the block still holds content other than insignificant-whitespace
 * text — the anchor that licenses dropping a whitespace-only tail node. */
function hasNonWhitespaceContent(children: RootContent[]): boolean {
  return children.some((child) => !(isPlainText(child) && WS_ONLY.test(child.value)));
}

function stripTrailing(children: RootContent[], isWrapperContent = false): void {
  while (children.length > 0) {
    const last = children[children.length - 1];
    if (isBareTrailingBreak(last)) {
      children.pop();
      continue;
    }
    if (last && MARK_WRAPPERS.has(last.type) && 'children' in last) {
      const inner = (last as Parent).children as RootContent[];
      stripTrailing(inner, true);
      if (inner.length === 0) {
        children.pop();
        continue;
      }
    }
    if (!isWrapperContent && isPlainText(last) && TRAILING_INSIGNIFICANT_WS.test(last.value)) {
      const trimmed = last.value.replace(TRAILING_INSIGNIFICANT_WS, '');
      if (trimmed.length > 0) {
        last.value = trimmed;
        continue;
      }
      if (hasNonWhitespaceContent(children.slice(0, -1))) {
        children.pop();
        continue;
      }
      if (children.every((child) => isPlainText(child) && WS_ONLY.test(child.value))) {
        const first = children[0] as Text;
        first.value = first.value.charAt(0);
        children.splice(1);
      }
    }
    break;
  }
}

const BLOCK_CONTAINERS = new Set(['paragraph', 'heading', 'tableCell']);

/** In-place: canonicalize the trailing edge of every block whose phrasing
 * content can end in a meaningless-at-block-edge construct. */
export function stripTrailingEdge(tree: Nodes): void {
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
