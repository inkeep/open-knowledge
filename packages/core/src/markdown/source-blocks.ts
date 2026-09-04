import { stripFrontmatter } from '../extensions/frontmatter.ts';
import type { MarkdownManager } from './index.ts';

export interface SourceBlock {
  start: number;
  end: number;
  kind: string;
  text: string;
  sourceStart: number | null;
  sourceEnd: number | null;
}

export function canonicalBlockKind(typeName: string): string {
  switch (typeName) {
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
    case 'list':
      return 'list';
    case 'codeBlock':
    case 'code':
      return 'code';
    case 'horizontalRule':
    case 'thematicBreak':
      return 'thematicBreak';
    case 'jsxComponent':
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
      return 'jsx';
    case 'htmlBlock':
    case 'html':
      return 'html';
    default:
      return typeName;
  }
}

function mdastText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map(mdastText).join('');
  }
  return '';
}

export function computeSourceBlocks(
  source: string,
  md: MarkdownManager,
): { blocks: SourceBlock[]; fmLineCount: number } {
  const { frontmatter, body } = stripFrontmatter(source);
  const fmLineCount = frontmatter === '' ? 0 : frontmatter.split('\n').length - 1;
  const bodyOffset = frontmatter.length;
  try {
    const blocks = md.parseToEditorMdast(body).children.map((child) => {
      const startOffset = child.position?.start.offset;
      const endOffset = child.position?.end.offset;
      return {
        start: (child.position?.start.line ?? Number.POSITIVE_INFINITY) + fmLineCount,
        end: (child.position?.end.line ?? Number.NEGATIVE_INFINITY) + fmLineCount,
        kind: canonicalBlockKind(child.type),
        text: mdastText(child),
        sourceStart: typeof startOffset === 'number' ? startOffset + bodyOffset : null,
        sourceEnd: typeof endOffset === 'number' ? endOffset + bodyOffset : null,
      };
    });
    return { blocks, fmLineCount };
  } catch {
    performance.mark('ok/block-spans/parse-failed');
    return { blocks: [], fmLineCount };
  }
}

const SYNTHETIC_IDENTITY_SENTINEL = '\u0000';

export function sourceBlockSnapshot(source: string, md: MarkdownManager): string[] {
  const { blocks } = computeSourceBlocks(source, md);
  return blocks.map((block) =>
    block.sourceStart !== null && block.sourceEnd !== null
      ? source.slice(block.sourceStart, block.sourceEnd)
      : `${SYNTHETIC_IDENTITY_SENTINEL}${block.kind}${SYNTHETIC_IDENTITY_SENTINEL}${block.text}`,
  );
}
