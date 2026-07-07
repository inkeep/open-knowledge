/**
 * Block-aligned splice computer for the map-driven Observer A path.
 *
 * Given the current body bytes (`oldBody`) and the new PM JSON (from
 * XmlFragment), compute ONE contiguous source-byte splice that rewrites
 * only the portion of the body whose top-level mdast blocks differ
 * structurally between old and new. Untouched prefix + suffix blocks
 * stay in Y.Text byte-identical.
 *
 * The computation is pure (no Y.Doc / no observers / no side effects):
 * parse oldBody → mdast, serialize new PM JSON → canonical newBody, parse
 * that → mdast, then walk the two tree.children sequences to find the
 * longest common prefix + suffix under structural equality (position
 * stripped) and emit splice = [oldPrefixEnd, oldSuffixStart] replaced by
 * newBody.slice(newPrefixEnd, newSuffixStart).
 *
 * "Structural equality" ignores `position` so a block that round-trips
 * to a canonical form (`*italic*` → `_italic_`) is treated as equal —
 * the OLD bytes survive in Y.Text untouched.
 *
 * Perf envelope: three full-document passes (parse + serialize + parse)
 * per drain-settle, synchronous, unbounded by doc size. Measured on a
 * 675 KB fuzz document this is hundreds of ms per drain — acceptable for
 * the settle path (it replaces incremental-diff work of similar order),
 * but a future large-doc latency report should start here.
 *
 * Returns null on parse failure or when any top-level block lacks a
 * position offset (caller falls back to whole-body diff path). The
 * non-contiguous-changes case (paragraph 1 + paragraph 3 edited,
 * paragraph 2 unchanged) collapses to one over-wide splice covering all
 * three — block-granular degradation in that narrow case, called out
 * as expected pending sub-block work.
 */
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type { RootContent } from 'mdast';

export interface MapDrivenSplice {
  readonly spliceStart: number;
  readonly spliceEnd: number;
  readonly newSlice: string;
}

export function computeMapDrivenBodySplice(
  oldBody: string,
  newPmJson: JSONContent,
  mdManager: MarkdownManager,
  onFallback?: (reason: 'parse-error' | 'missing-position', err?: unknown) => void,
): MapDrivenSplice | null {
  let oldChildren: readonly RootContent[];
  let newBody: string;
  let newChildren: readonly RootContent[];
  try {
    oldChildren = mdManager.parseToMdast(oldBody).children;
    newBody = mdManager.serialize(newPmJson);
    newChildren = mdManager.parseToMdast(newBody).children;
  } catch (err) {
    // Swallowing is the contract (caller falls back to the whole-body diff
    // path), but the swallow must not be silent: a systemic parse/serialize
    // regression routing every drain through the fallback would otherwise
    // look identical to normal operation. The error rides the callback so
    // the caller can surface its message without this module logging.
    onFallback?.('parse-error', err);
    return null;
  }

  if (!allBlocksCarryPositions(oldChildren) || !allBlocksCarryPositions(newChildren)) {
    onFallback?.('missing-position');
    return null;
  }

  let prefixLen = 0;
  while (
    prefixLen < oldChildren.length &&
    prefixLen < newChildren.length &&
    structurallyEqual(oldChildren[prefixLen], newChildren[prefixLen])
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldChildren.length - prefixLen &&
    suffixLen < newChildren.length - prefixLen &&
    structurallyEqual(
      oldChildren[oldChildren.length - 1 - suffixLen],
      newChildren[newChildren.length - 1 - suffixLen],
    )
  ) {
    suffixLen++;
  }

  const spliceStart =
    prefixLen > 0
      ? blockEndOffset(oldChildren[prefixLen - 1])
      : oldChildren.length > 0
        ? blockStartOffset(oldChildren[0])
        : 0;
  const spliceEnd =
    suffixLen > 0 ? blockStartOffset(oldChildren[oldChildren.length - suffixLen]) : oldBody.length;

  const newSliceStart =
    prefixLen > 0
      ? blockEndOffset(newChildren[prefixLen - 1])
      : newChildren.length > 0
        ? blockStartOffset(newChildren[0])
        : 0;
  const newSliceEnd =
    suffixLen > 0 ? blockStartOffset(newChildren[newChildren.length - suffixLen]) : newBody.length;

  return {
    spliceStart,
    spliceEnd,
    newSlice: newBody.slice(newSliceStart, newSliceEnd),
  };
}

function allBlocksCarryPositions(children: readonly RootContent[]): boolean {
  for (const child of children) {
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number') return false;
  }
  return true;
}

function blockStartOffset(node: RootContent): number {
  const offset = node.position?.start?.offset;
  if (typeof offset !== 'number') {
    throw new Error('mdast node missing position.start.offset');
  }
  return offset;
}

function blockEndOffset(node: RootContent): number {
  const offset = node.position?.end?.offset;
  if (typeof offset !== 'number') {
    throw new Error('mdast node missing position.end.offset');
  }
  return offset;
}

function structurallyEqual(a: RootContent, b: RootContent): boolean {
  return stringifyIgnorePosition(a) === stringifyIgnorePosition(b);
}

function stringifyIgnorePosition(node: unknown): string {
  return JSON.stringify(node, (key, value) => (key === 'position' ? undefined : value));
}
