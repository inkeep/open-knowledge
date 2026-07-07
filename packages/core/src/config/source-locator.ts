/**
 * Source-position locator for yaml@2 `Document` ASTs.
 *
 * Given a parsed `Document`, the original source string, and a Zod
 * `issue.path` (an array of property keys), find the offending YAML node
 * and translate its byte range to 1-indexed line/column. Also emits a
 * 3-line snippet with a caret marker under the offending token.
 *
 * Used by:
 * - `loader.ts` — produce `file:line:col` errors for `loadConfig` failures
 * - `readConfigSafely` — annotate cold-start recovery errors
 * - `ok config validate` — show users *where* their config is wrong
 */

import { type Document, isCollection, isNode, type Node } from 'yaml';
import type { ConfigIssueSource } from './errors.ts';

export interface LocateOptions {
  /** Absolute path of the file the source was read from. */
  file: string;
  /** Source text of the YAML file (for snippet rendering). */
  source: string;
  /** The parsed Document. yaml@2's union of typed variants narrows fine here. */
  doc: Document;
  /** The issue's path (e.g., `['mcp', 'tools', 'grep', 'maxResults']`). */
  path: (string | number)[];
}

/**
 * Resolve a path to a yaml@2 Node. Walks `getIn(path)` first (the standard
 * mutation API). Falls back to walking ancestor paths when the exact path
 * doesn't resolve to a node — this happens when the issue is about a
 * missing-required field (the path doesn't exist in source), so we point
 * at the nearest existing parent.
 */
function resolveNode(doc: Document, path: (string | number)[]): Node | null {
  if (path.length === 0) {
    return (doc.contents as Node | null) ?? null;
  }
  // yaml@2's getIn signature is getIn(path, keepScalar?) — passing true
  // returns the Scalar node (with .range) instead of the unwrapped value.
  const direct = doc.getIn(path, true);
  if (isNode(direct)) {
    return direct;
  }
  // Walk up the path looking for the nearest existing ancestor.
  for (let i = path.length - 1; i >= 0; i--) {
    const parent = doc.getIn(path.slice(0, i), true);
    if (isNode(parent)) {
      return parent;
    }
  }
  return (doc.contents as Node | null) ?? null;
}

/**
 * Convert a byte offset in the source string to 1-indexed line and column.
 * Walks the source linearly (O(n)). For typical config files (~50-200 lines)
 * this is well under 1ms.
 */
function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const cap = Math.min(offset, source.length);
  for (let i = 0; i < cap; i++) {
    if (source.charCodeAt(i) === 10) {
      // \n
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/**
 * Render a 3-line snippet of the source with a caret marker under the
 * offending token. Format mirrors Biome / tsc lint output:
 *
 * ```
 *   12 |   tools:
 *   13 |     search:
 * > 14 |       maxResults: "fifty"
 *      |       ^^^^^^^^^^^^^^^^^^^
 *   15 |
 * ```
 *
 * `endOffset` is exclusive (yaml@2's `range[1]`); the caret span covers the
 * offending token. Capped to the rest of the line if the range crosses a
 * newline.
 */
function renderSnippet(
  source: string,
  startOffset: number,
  endOffset: number,
  line: number,
  column: number,
): string {
  const lines = source.split('\n');
  const lineIdx = line - 1; // 0-based
  if (lineIdx < 0 || lineIdx >= lines.length) return '';
  const targetLine = lines[lineIdx] ?? '';

  // Cap the highlight span at the line boundary in source. yaml@2's range
  // can span multiple lines for blocks; we only highlight on the start line.
  const lineStartOffset = startOffset - (column - 1);
  const lineEndOffset = lineStartOffset + targetLine.length;
  const highlightEnd = Math.min(endOffset, lineEndOffset);
  const highlightLen = Math.max(1, highlightEnd - startOffset);

  const out: string[] = [];
  const lineNumWidth = String(lineIdx + 2).length;
  // Render up to 1 line before, the target line, and 1 line after (when present).
  for (let i = Math.max(0, lineIdx - 1); i <= Math.min(lines.length - 1, lineIdx + 1); i++) {
    const isTarget = i === lineIdx;
    const marker = isTarget ? '>' : ' ';
    const num = String(i + 1).padStart(lineNumWidth, ' ');
    out.push(`${marker} ${num} | ${lines[i] ?? ''}`);
    if (isTarget) {
      const pad = ' '.repeat(2 + lineNumWidth + 3 + column - 1);
      out.push(`${pad}${'^'.repeat(highlightLen)}`);
    }
  }
  return out.join('\n');
}

/**
 * Locate the source position for an issue path, returning a `ConfigIssueSource`
 * suitable for attachment to `ConfigIssue.source`. Returns `undefined` when
 * the path cannot be resolved to any node (shouldn't happen — `resolveNode`
 * falls back to the document root).
 */
export function locateIssue(options: LocateOptions): ConfigIssueSource | undefined {
  const node = resolveNode(options.doc, options.path);
  if (!node) return undefined;
  // For map/seq nodes pointing at a missing-required key, prefer the parent
  // node's start range (so the snippet shows the surrounding context). The
  // `range` on a scalar leaf points at the value text directly, which is
  // what we want for invalid_type / out_of_range issues.
  const range = node.range;
  if (!range) return undefined;
  const [startOffset, , endOffset = startOffset] = range;
  const { line, column } = offsetToLineCol(options.source, startOffset);
  // For collection nodes, the snippet of the whole block is overwhelming —
  // fall back to a single-line snippet at the start position.
  const useSingleLine = isCollection(node);
  const snippet = useSingleLine
    ? renderSnippet(options.source, startOffset, startOffset + 1, line, column)
    : renderSnippet(options.source, startOffset, endOffset, line, column);
  return {
    file: options.file,
    line,
    column,
    snippet: snippet.length > 0 ? snippet : undefined,
  };
}
