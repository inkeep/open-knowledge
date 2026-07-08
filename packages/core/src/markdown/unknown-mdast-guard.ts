
import type { Root as MdastRoot } from 'mdast';
import type { VFile } from 'vfile';

export const KNOWN_MDAST_TYPES: ReadonlySet<string> = new Set([
  'root',
  'paragraph',
  'heading',
  'text',
  'emphasis',
  'strong',
  'blockquote',
  'list',
  'listItem',
  'code',
  'inlineCode',
  'link',
  'image',
  'linkReference',
  'imageReference',
  'definition',
  'html',
  'thematicBreak',
  'break',
  'yaml',
  'toml',
  'table',
  'tableRow',
  'tableCell',
  'delete',
  'footnoteDefinition',
  'footnoteReference',
  'mdxFlowExpression',
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
  'mdxTextExpression',
  'wikiLink',
  'wikiLinkEmbed',
  'tag',
  'math',
  'inlineMath',
  'mark',
  'comment',
  'commentBlock',
  'rawMdxFallbackMdast',
]);

export function unknownMdastGuardPlugin() {
  return (tree: MdastRoot, file: VFile) => {
    const source = String(file.value ?? '');
    walk(tree as unknown as WalkableNode, source);
  };
}

interface WalkablePoint {
  line?: number;
  column?: number;
  offset?: number;
}

interface WalkableNode {
  type?: string;
  children?: unknown[];
  position?: { start?: WalkablePoint; end?: WalkablePoint };
}

function walk(node: WalkableNode | null | undefined, source: string): void {
  if (!node || typeof node !== 'object') return;
  if (!Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i] as WalkableNode;
    if (!child || typeof child !== 'object' || typeof child.type !== 'string') continue;
    if (!KNOWN_MDAST_TYPES.has(child.type)) {
      node.children[i] = toRawMdxFallbackMdast(child, source);
    } else {
      walk(child, source);
    }
  }
}

interface RawMdxFallbackMdast {
  type: 'rawMdxFallbackMdast';
  originalType: string;
  value: string;
  unresolvedPosition: boolean;
  position?: WalkableNode['position'];
}

function resolvePointOffset(point: WalkablePoint | undefined, source: string): number | null {
  if (!point || typeof point !== 'object') return null;
  if (typeof point.offset === 'number') {
    return point.offset >= 0 && point.offset <= source.length ? point.offset : null;
  }
  const { line, column } = point;
  if (typeof line !== 'number' || typeof column !== 'number' || line < 1 || column < 1) {
    return null;
  }
  let lineStart = 0;
  for (let current = 1; current < line; current++) {
    const newline = source.indexOf('\n', lineStart);
    if (newline === -1) return null;
    lineStart = newline + 1;
  }
  const newline = source.indexOf('\n', lineStart);
  const lineEnd = newline === -1 ? source.length : newline;
  const offset = lineStart + column - 1;
  return offset <= lineEnd ? offset : null;
}

function resolveSourceSlice(position: WalkableNode['position'], source: string): string | null {
  if (!position) return null;
  const start = resolvePointOffset(position.start, source);
  const end = resolvePointOffset(position.end, source);
  if (start === null || end === null || end < start) return null;
  return source.slice(start, end);
}

export function toRawMdxFallbackMdast(node: WalkableNode, source: string): RawMdxFallbackMdast {
  const sourceSlice = resolveSourceSlice(node.position, source);
  return {
    type: 'rawMdxFallbackMdast',
    originalType: node.type ?? 'unknown',
    value: sourceSlice ?? '',
    unresolvedPosition: sourceSlice === null,
    position: node.position,
  };
}
