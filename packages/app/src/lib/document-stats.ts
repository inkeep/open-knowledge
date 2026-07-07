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

/**
 * CJK / Thai / Khmer etc. have no whitespace word boundaries — detect and route to Intl.Segmenter.
 * The Compatibility Ideographs lower bound is written as `豈` (not the literal char)
 * because U+F900 NFC-normalizes to U+8C48, and editors that auto-normalize would silently
 * widen the regex by ~27K codepoints.
 */
const NON_SPACE_SCRIPT_RE = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯฀-๿ក-៿]/;

/** Tokens like `#`, `>`, `---` are pure markdown syntax — exclude them from word count. */
const WORD_LIKE_RE = /[\p{L}\p{N}]/u;

interface MdastLikeNode {
  type: string;
  value?: string;
  children?: MdastLikeNode[];
  data?: { alias?: string | null; [key: string]: unknown };
}

/**
 * Node types whose `value` is the visible rendered text. `inlineCode` and
 * `code` are visible code content the reader sees; `tag` carries a bare
 * `#tagname` value rendered as a chip.
 */
const VALUE_BEARING_TYPES = new Set(['text', 'inlineCode', 'code', 'tag']);

/**
 * Skipped subtrees: raw HTML, MDX expressions/ESM, link reference defs,
 * frontmatter, images (alt text isn't reading content), and both fallback
 * variants — `rawMdxFallback` (PM-side) and `rawMdxFallbackMdast` (mdast-side
 * from unknown-mdast-guard) — whose `value` carries opaque source bytes that
 * shouldn't count as visible text. JSX containers (`mdxJsxFlowElement` /
 * `mdxJsxTextElement`) are intentionally NOT skipped — they recurse into
 * children, so a `<Callout>` body counts but the tag/attribute names
 * ("Callout", "type", "info") don't.
 */
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

/**
 * Block-level container types — emit a newline separator after their children
 * so adjacent blocks don't fuse ("hello" + "world" → "hello\nworld", not
 * "helloworld"). Inline containers (emphasis, strong, link, etc.) intentionally
 * omit separators so their text concatenates with the surrounding flow.
 */
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
      // Fenced/indented `code` is block-level — emit a separator so its tail
      // token doesn't fuse with the next block ("1" + "after" → "1after").
      // `inlineCode` and `tag` are inline and intentionally concatenate.
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

/**
 * Rough token estimate. ~4 chars/token is the average for English under
 * cl100k_base / o200k_base BPE; CJK tokenizes much denser (each ideograph is
 * typically 1–2 tokens), so any document containing CJK / Thai / Khmer drops
 * to ~1.5 chars/token. Mixed-script docs pick the denser ratio globally —
 * coarse but matches the existing word-counting branch.
 */
function estimateTokens(text: string): number {
  const ratio = NON_SPACE_SCRIPT_RE.test(text) ? 1.5 : 4;
  return Math.ceil(text.length / ratio);
}

/**
 * Count words / chars / tokens over already-visible text (no further markdown
 * stripping). `chars` is the visible-text length; word counting routes to
 * Intl.Segmenter for non-space-separated scripts. Shared by the document-level
 * and selection-level entry points so a given passage counts identically
 * wherever it is measured.
 */
function countStats(visible: string): DocumentStats {
  if (!visible) return { words: 0, chars: 0, tokens: 0 };
  const words = NON_SPACE_SCRIPT_RE.test(visible)
    ? countWordsBySegmenter(visible)
    : countWordsByWhitespace(visible);
  return { words, chars: visible.length, tokens: estimateTokens(visible) };
}

/**
 * Compute body-only stats (words, chars, tokens) from raw markdown text.
 *
 * Frontmatter and markdown/MDX syntax are excluded so counts reflect what the
 * reader sees ("how long is my article?"). The body is parsed to mdast and
 * only visible-text leaves contribute — JSX tag names, attribute names, link
 * URLs, image alt text, and link-reference definitions don't count. Handles
 * CJK / Thai / Khmer via Intl.Segmenter when the visible text contains
 * non-space-separated scripts.
 */
export function computeBodyStats(fullText: string): DocumentStats {
  if (!fullText) return { words: 0, chars: 0, tokens: 0 };
  const { body } = stripFrontmatter(fullText);
  if (!body.trim()) return { words: 0, chars: 0, tokens: 0 };
  return countStats(extractVisibleText(body));
}

/**
 * Compute stats for an editor selection, sharing the document-level counting
 * core so the same passage yields the same numbers in either edit mode.
 *
 * WYSIWYG selections arrive as already-visible ProseMirror text — pass
 * `isMarkdown: false` to count directly. Source-mode selections are raw
 * markdown — pass `isMarkdown: true` to run them through the same visible-text
 * extraction the document counter uses (syntax / frontmatter-region characters
 * stripped). Frontmatter is deliberately NOT stripped as a leading block: a
 * selection is a fragment, not a document.
 *
 * An empty / whitespace-only selection yields EMPTY_STATS. Callers that want a
 * "no selection → show document counts" fallback decide that upstream by
 * passing `null` instead of calling this.
 */
export function computeSelectionStats(
  text: string,
  { isMarkdown }: { isMarkdown: boolean },
): DocumentStats {
  const trimmed = text.trim();
  if (!trimmed) return EMPTY_STATS;
  return countStats(isMarkdown ? extractVisibleText(text) : trimmed);
}
