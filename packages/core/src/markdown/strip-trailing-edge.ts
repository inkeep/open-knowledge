import type { Break, Nodes, Parent, RootContent, Text } from 'mdast';

const MARK_WRAPPERS = new Set(['strong', 'emphasis', 'delete', 'link', 'mark', 'comment']);

const HTML_BREAK_SPELLING = '<br />';

function isBareTrailingBreak(node: RootContent | undefined): node is Break {
  if (!node || node.type !== 'break') return false;
  const sourceRaw = node.data?.sourceRaw;
  return typeof sourceRaw !== 'string' || sourceRaw.length === 0;
}

function respellAsHtmlBreak(node: Break): void {
  node.data ??= {};
  node.data.sourceRaw = HTML_BREAK_SPELLING;
  node.data.sourceStyle = 'html';
}

function isPlainText(node: RootContent | undefined): node is Text {
  if (!node || node.type !== 'text') return false;
  const sourceRaw = (node.data as { sourceRaw?: unknown } | undefined)?.sourceRaw;
  return typeof sourceRaw !== 'string' || sourceRaw.length === 0;
}

const TRAILING_INSIGNIFICANT_WS = /[ \t]+$/;
const WS_ONLY = /^[ \t]*$/;

function hasNonWhitespaceContent(children: RootContent[]): boolean {
  return children.some((child) => !(isPlainText(child) && WS_ONLY.test(child.value)));
}

function stripTrailing(children: RootContent[], isWrapperContent = false): void {
  while (children.length > 0) {
    const last = children[children.length - 1];
    if (isBareTrailingBreak(last)) {
      respellAsHtmlBreak(last);
      break;
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
