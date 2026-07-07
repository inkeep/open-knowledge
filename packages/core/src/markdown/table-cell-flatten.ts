import type { Html, List, Nodes, PhrasingContent, Root, TableCell } from 'mdast';
import { visit } from 'unist-util-visit';

const CELL_PHRASING_TYPES: ReadonlySet<string> = new Set([
  'break',
  'delete',
  'emphasis',
  'footnoteReference',
  'html',
  'image',
  'imageReference',
  'inlineCode',
  'link',
  'linkReference',
  'strong',
  'text',
]);

function substituteBreaksWithBrHtml(node: { children?: Nodes[] }): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  children.forEach((child, i) => {
    if (child.type === 'break') {
      children[i] = { type: 'html', value: '<br />' } satisfies Html;
      return;
    }
    substituteBreaksWithBrHtml(child as { children?: Nodes[] });
  });
}

function normalizeCellValueNodes(node: { children?: Nodes[] }): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (const child of children) {
    if (child.type === 'inlineCode' || child.type === 'html') {
      if (child.value.includes('\n')) {
        child.value = child.value.replace(/[ \t]*\n[ \t]*/g, ' ');
      }
      if (child.type === 'html' && child.value.includes('|')) {
        child.value = child.value.replace(/\|/g, '\\|');
      }
    }
    normalizeCellValueNodes(child as { children?: Nodes[] });
  }
}

export function flattenTableCellsInTree(tree: Root): void {
  visit(tree, 'tableCell', (cell: TableCell) => {
    const hasBlockChild = cell.children.some((child) => !CELL_PHRASING_TYPES.has(child.type));
    if (hasBlockChild) {
      cell.children = flattenCellBlocks(cell.children);
    }
    substituteBreaksWithBrHtml(cell);
    normalizeCellValueNodes(cell);
  });
}

export function flattenCellBlocks(children: readonly Nodes[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let pendingBreaks = 0;

  const pushBreak = (): void => {
    if (out.length > 0) pendingBreaks += 1;
  };

  const emit = (node: PhrasingContent): void => {
    while (pendingBreaks > 0) {
      out.push({ type: 'break' });
      pendingBreaks -= 1;
    }
    out.push(node);
  };

  const pushLines = (value: string): void => {
    value.split('\n').forEach((line, i) => {
      if (i > 0) pushBreak();
      if (line.length > 0) emit({ type: 'text', value: line });
    });
  };

  const pushList = (list: List): void => {
    const ordered = list.ordered === true;
    const start = typeof list.start === 'number' ? list.start : 1;
    const data = list.data as { bulletMarker?: string; listMarkerDelimiter?: string } | undefined;
    const bullet = typeof data?.bulletMarker === 'string' ? data.bulletMarker : '-';
    const delimiter =
      typeof data?.listMarkerDelimiter === 'string' ? data.listMarkerDelimiter : '.';
    list.children.forEach((item, i) => {
      if (i > 0) pushBreak();
      const marker = ordered ? `${start + i}${delimiter} ` : `${bullet} `;
      emit({ type: 'text', value: marker });
      item.children.forEach((block, j) => {
        if (j > 0) pushBreak();
        pushBlock(block);
      });
    });
  };

  const pushBlock = (node: Nodes): void => {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        node.children.forEach(emit);
        return;
      case 'list':
        pushList(node);
        return;
      case 'code':
      case 'html':
        pushLines(node.value);
        return;
      case 'thematicBreak':
        emit({ type: 'text', value: node.data?.sourceRaw ?? '---' });
        return;
      default: {
        const withChildren = node as { children?: Nodes[] };
        if (Array.isArray(withChildren.children) && withChildren.children.length > 0) {
          withChildren.children.forEach((child, i) => {
            if (i > 0) pushBreak();
            pushBlock(child);
          });
          return;
        }
        const withValue = node as { value?: unknown };
        if (typeof withValue.value === 'string') {
          pushLines(withValue.value);
          return;
        }
        console.warn(
          JSON.stringify({ event: 'table-cell-flatten-dropped-block', nodeType: node.type }),
        );
      }
    }
  };

  children.forEach((child, i) => {
    if (i > 0) pushBreak();
    pushBlock(child);
  });

  return out;
}
