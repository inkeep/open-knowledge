import type { ListItem, Nodes, Paragraph, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

const SPACE_CHAR_REF = '&#x20;';

function isTaskItem(node: Nodes): node is ListItem {
  return node.type === 'listItem' && typeof (node as ListItem).checked === 'boolean';
}

function isEmptyTaskItem(item: ListItem): boolean {
  const children = item.children ?? [];
  if (children.length !== 1) return false;
  const only = children[0];
  return only?.type === 'paragraph' && (only.children?.length ?? 0) === 0;
}

function isMintedEmptyTaskItem(item: ListItem): boolean {
  const children = item.children ?? [];
  if (children.length !== 1) return false;
  const only = children[0];
  if (only?.type !== 'paragraph' || (only.children?.length ?? 0) !== 1) return false;
  const text = only.children[0];
  if (text?.type !== 'text' || text.value !== SPACE_CHAR_REF) return false;
  const spans = text.data?.entityRefSpans;
  if (!Array.isArray(spans) || spans.length !== 1) return false;
  const span = spans[0];
  return span?.offset === 0 && span.length === SPACE_CHAR_REF.length && span.raw === SPACE_CHAR_REF;
}

export function mintEmptyTaskItemContent(tree: Nodes): void {
  visit(tree, 'listItem', (node: ListItem) => {
    if (!isTaskItem(node) || !isEmptyTaskItem(node)) return;
    const paragraph = node.children[0] as Paragraph;
    const minted: Text = { type: 'text', value: ' ', data: { sourceRaw: SPACE_CHAR_REF } };
    paragraph.children = [minted];
  });
}

function unmintEmptyTaskItemContent(tree: Nodes): void {
  visit(tree, 'listItem', (node: ListItem) => {
    if (!isTaskItem(node) || !isMintedEmptyTaskItem(node)) return;
    (node.children[0] as Paragraph).children = [];
  });
}

export function emptyTaskItemUnmintPlugin() {
  return (tree: Root) => {
    unmintEmptyTaskItemContent(tree);
  };
}
