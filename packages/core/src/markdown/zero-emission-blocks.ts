import type { Root as MdastRoot, Paragraph, PhrasingContent, RootContent } from 'mdast';

type WithData = { data?: Record<string, unknown> };
type WithValue = { value?: unknown };
type WithChildren = { children?: unknown[] };

function sourceRawOf(node: unknown): unknown {
  return (node as WithData).data?.sourceRaw;
}

function emitsNoInlineBytes(node: PhrasingContent): boolean {
  if (node.type === 'text') return (node as WithValue).value === '';
  if (node.type === 'mdxJsxTextElement') return sourceRawOf(node) === '';
  return false;
}

export function isBlankLineParagraph(node: unknown): boolean {
  if ((node as { type?: string }).type !== 'paragraph') return false;
  const children = (node as Paragraph).children ?? [];
  return children.every(emitsNoInlineBytes);
}

function tableWidth(node: RootContent): number {
  const rows = ((node as WithChildren).children ?? []) as WithChildren[];
  const headerWidth = rows[0]?.children?.length ?? 0;
  let bodyWidth = 0;
  for (let i = 1; i < rows.length; i++) {
    bodyWidth = Math.max(bodyWidth, rows[i]?.children?.length ?? 0);
  }
  const align = (node as { align?: unknown[] }).align ?? [];
  return Math.max(headerWidth, bodyWidth, align.length);
}

function emitsNoBlockBytes(node: RootContent): boolean {
  switch (node.type) {
    case 'table':
      return tableWidth(node) === 0;
    case 'code':
      return (
        (node as WithData).data?.sourceStyle === 'indented' &&
        /^\n*$/.test(((node as WithValue).value as string | undefined) ?? '')
      );
    case 'thematicBreak':
      return sourceRawOf(node) === '';
    case 'html':
      return (((node as WithValue).value as string | undefined) ?? '') === '';
    case 'mdxJsxFlowElement':
      return (
        sourceRawOf(node) === undefined &&
        (node as WithData).data?.htmlBoundary === undefined &&
        ((node as WithChildren).children ?? []).length === 0 &&
        !(node as { name?: unknown }).name
      );
    case 'list':
      return ((node as WithChildren).children ?? []).length === 0;
    default:
      return false;
  }
}

export function pruneZeroEmissionBlocks(root: MdastRoot): void {
  const kept: MdastRoot['children'] = [];
  for (const child of root.children) {
    if (child.type === 'table' && tableWidth(child) === 0) {
      console.warn(
        JSON.stringify({
          event: 'table-serialize-dropped-empty',
          rows: ((child as WithChildren).children ?? []).length,
        }),
      );
      continue;
    }
    if (emitsNoBlockBytes(child)) continue;
    if (child.type === 'paragraph' && child.children.length > 0 && isBlankLineParagraph(child)) {
      child.children = [];
    }
    kept.push(child);
  }
  root.children = kept;
}
