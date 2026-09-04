import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import { getSharedMarkdownManager } from '@/editor/utils/md-singleton';

export interface DocumentStats {
  words: number;
  chars: number;
  tokens: number;
}

export const EMPTY_STATS: DocumentStats = {
  words: 0,
  chars: 0,
  tokens: 0,
};

const NON_SPACE_SCRIPT_RE = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯฀-๿ក-៿]/;

const WORD_LIKE_RE = /[\p{L}\p{N}]/u;

interface MdastLikeNode {
  type: string;
  value?: string;
  children?: MdastLikeNode[];
  data?: { alias?: string | null; [key: string]: unknown };
}

const VALUE_BEARING_TYPES = new Set(['text', 'inlineCode', 'code', 'tag']);

const SKIP_TYPES = new Set([
  'html',
  'definition',
  'footnoteDefinition',
  'yaml',
  'toml',
  'image',
  'imageReference',
  'mdxFlowExpression',
  'mdxTextExpression',
  'mdxjsEsm',
  'rawMdxFallback',
  'rawMdxFallbackMdast',
]);

const BLOCK_CONTAINER_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'list',
  'listItem',
  'thematicBreak',
  'table',
  'tableRow',
  'tableCell',
  'mdxJsxFlowElement',
  'commentBlock',
]);

function collectVisibleText(node: MdastLikeNode | undefined, parts: string[]): void {
  if (!node) return;
  const t = node.type;
  if (SKIP_TYPES.has(t)) return;
  if (VALUE_BEARING_TYPES.has(t)) {
    if (node.value) {
      parts.push(node.value);
      if (t === 'code') parts.push('\n');
    }
    return;
  }
  if (t === 'wikiLink' || t === 'wikiLinkEmbed') {
    const label = node.data?.alias ?? node.value ?? '';
    if (label) parts.push(label);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectVisibleText(child, parts);
    if (BLOCK_CONTAINER_TYPES.has(t) && parts.length > 0) {
      const last = parts[parts.length - 1];
      if (last && !last.endsWith('\n')) parts.push('\n');
    }
  }
}

function extractVisibleText(body: string): string {
  try {
    const tree = getSharedMarkdownManager().parseToMdast(body) as MdastLikeNode;
    const parts: string[] = [];
    collectVisibleText(tree, parts);
    return parts.join('').trim();
  } catch (err: unknown) {
    console.warn('[document-stats] mdast parse failed, falling back to raw text', err);
    return body.trim();
  }
}

function countWordsByWhitespace(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const tok of text.split(/\s+/)) {
    if (WORD_LIKE_RE.test(tok)) count++;
  }
  return count;
}

function countWordsBySegmenter(text: string): number {
  const SegmenterCtor = (globalThis as { Intl: { Segmenter?: typeof Intl.Segmenter } }).Intl
    .Segmenter;
  if (!SegmenterCtor) return countWordsByWhitespace(text);
  const segmenter = new SegmenterCtor(undefined, { granularity: 'word' });
  let count = 0;
  for (const seg of segmenter.segment(text)) {
    if (seg.isWordLike) count++;
  }
  return count;
}

function estimateTokens(text: string): number {
  const ratio = NON_SPACE_SCRIPT_RE.test(text) ? 1.5 : 4;
  return Math.ceil(text.length / ratio);
}

function countStats(visible: string): DocumentStats {
  if (!visible) return { words: 0, chars: 0, tokens: 0 };
  const words = NON_SPACE_SCRIPT_RE.test(visible)
    ? countWordsBySegmenter(visible)
    : countWordsByWhitespace(visible);
  return { words, chars: visible.length, tokens: estimateTokens(visible) };
}

export function computeBodyStats(fullText: string): DocumentStats {
  if (!fullText) return { words: 0, chars: 0, tokens: 0 };
  const { body } = stripFrontmatter(fullText);
  if (!body.trim()) return { words: 0, chars: 0, tokens: 0 };
  return countStats(extractVisibleText(body));
}

export function computePlainTextStats(fullText: string): DocumentStats {
  return countStats(fullText);
}

export function computeSelectionStats(
  text: string,
  { isMarkdown }: { isMarkdown: boolean },
): DocumentStats {
  const trimmed = text.trim();
  if (!trimmed) return EMPTY_STATS;
  return countStats(isMarkdown ? extractVisibleText(text) : trimmed);
}
