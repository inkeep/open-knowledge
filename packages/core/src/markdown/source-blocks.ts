/**
 * Top-level block ordinals, computed from markdown source alone.
 *
 * A "block ordinal" is an index into the document's top-level children, and it
 * is the coordinate three unrelated features speak in: WYSIWYG lint
 * decorations, cross-mode position mapping, and the agent write-flash range
 * (`changedBlockRange`). All three index through this module, so there is one
 * definition of the coordinate and the app and the server cannot drift apart on
 * it.
 *
 * The parse is `parseToEditorMdast`, not `parseToMdast`: the editor view is
 * what the ordinals must align with, and it differs from the CommonMark one by
 * materializing preserved blank runs as empty paragraphs. Those paragraphs are
 * real top-level children of the ProseMirror document, so a block table that
 * skipped them would be off by one after the first preserved blank run.
 *
 * This module is deliberately dependency-light — mdast positions and string
 * slicing, no ProseMirror — so the server can index block ordinals without
 * building a document. `pm-source-map.ts` is the ProseMirror-side counterpart
 * (`map.blocks` is the same table, built during a real parse); the two agree
 * because they read the same mdast top-level positions.
 */

import { stripFrontmatter } from '../extensions/frontmatter.ts';
import type { MarkdownManager } from './index.ts';

/** A top-level source block enriched with the fields the position resolver grades on. */
export interface SourceBlock {
  /** 1-based inclusive line span in full-source coordinates. */
  start: number;
  end: number;
  /** Canonical block kind, normalized across the mdast and PM vocabularies. */
  kind: string;
  /** Plain text content (markdown syntax stripped), for content-equality checks. */
  text: string;
  /**
   * Char offsets of the block's source bytes, in full-source coordinates, or
   * null when the block carried no mdast position.
   *
   * Null is not the same as an empty span. A materialized blank-run paragraph
   * is positioned and zero-width — it genuinely occupies no bytes — while an
   * unpositioned block is one whose bytes cannot be named at all. Slicing on a
   * sentinel would hand back the wrong bytes rather than none, so the
   * distinction is carried rather than collapsed. In practice only nodes
   * synthesized outside remark land here; everything remark parses is
   * positioned.
   */
  sourceStart: number | null;
  sourceEnd: number | null;
}

/**
 * Normalize a mdast or ProseMirror node-type name to a shared block-kind
 * vocabulary so a block captured in one representation can be type-matched
 * against the other. mdast and PM disagree on several names for the same
 * construct (`list` vs `bulletList`/`orderedList`, `code` vs `codeBlock`,
 * `thematicBreak` vs `horizontalRule`); unknown names pass through unchanged so
 * an exact name match still counts.
 */
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

/**
 * Concatenate the visible text of an mdast node (its descendant literal values),
 * the mdast counterpart of ProseMirror's `node.textContent`. Kept structural
 * (walks `value`/`children` without an mdast type import) so this leaf module
 * stays free of the `mdast` dependency.
 */
function mdastText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map(mdastText).join('');
  }
  return '';
}

/**
 * Top-level body blocks for a full `Y.Text('source')` snapshot. The body region
 * (after the FM fence) is parsed to mdast; line and char spans are shifted back
 * into full-source coordinates so full-source positions index into them
 * directly. The single positioned parse the resolver relies on.
 */
export function computeSourceBlocks(
  source: string,
  md: MarkdownManager,
): { blocks: SourceBlock[]; fmLineCount: number } {
  const { frontmatter, body } = stripFrontmatter(source);
  const fmLineCount = frontmatter === '' ? 0 : frontmatter.split('\n').length - 1;
  // The body is a suffix of the source, so one offset carries every char span
  // across the frontmatter fence. Same quantity as `Projection.bodyOffset`.
  const bodyOffset = frontmatter.length;
  // The editor view, not the CommonMark one: a preserved blank line is a
  // paragraph in the PM doc, and this array is index-aligned with those
  // children. Losing the alignment silently disables every decoration and
  // strands the count tripwire.
  //
  // `parseToEditorMdast` throws on structurally invalid MDX (an unclosed or
  // mismatched JSX tag) — a routine transient state while editing raw source.
  // Every consumer (the lint decorations, the mode-switch resolver and the
  // agent write-flash range) already treats an empty block list as "no anchor",
  // so degrading to no blocks costs only the anchor. A synchronous throw would
  // be worse: the toggle captures the source block before the mode flips, so it
  // would abort the flip and strand the user in the mode they were leaving.
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
    // Leave a breadcrumb: the no-blocks degradation is indistinguishable from a
    // genuinely empty body downstream, and a systematic parse regression on
    // valid markdown would silently send every mode switch to the top of the
    // document with nothing to find. Raw `performance.mark` rather than the
    // `mark()` helper keeps this leaf free of the perf module's graph, and the
    // mark name is the one existing traces search for.
    performance.mark('ok/block-spans/parse-failed');
    return { blocks: [], fmLineCount };
  }
}

/**
 * Opens a synthetic block identity. NUL cannot occur in a markdown slice, so a
 * fallback identity can never be mistaken for one.
 */
const SYNTHETIC_IDENTITY_SENTINEL = '\u0000';

/**
 * One identity string per top-level block, index-aligned with the document's
 * children — the input `changedBlockRange` diffs a before/after pair of.
 *
 * A block's own source bytes are its identity, so any byte an agent changed
 * inside a block changes that block's string, and a block nobody touched keeps
 * its own. That is sharper than the block's plain text, which would call
 * `[a](x)` and `[a](y)` the same block and so lose a link-only rewrite.
 *
 * An unpositioned block has no bytes to name and falls back to a synthetic
 * kind+text identity — still change-sensitive, and impossible to confuse with a
 * real slice.
 */
export function sourceBlockSnapshot(source: string, md: MarkdownManager): string[] {
  const { blocks } = computeSourceBlocks(source, md);
  return blocks.map((block) =>
    block.sourceStart !== null && block.sourceEnd !== null
      ? source.slice(block.sourceStart, block.sourceEnd)
      : `${SYNTHETIC_IDENTITY_SENTINEL}${block.kind}${SYNTHETIC_IDENTITY_SENTINEL}${block.text}`,
  );
}
