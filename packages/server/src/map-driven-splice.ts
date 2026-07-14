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
 * When the changed region is a single container block on both sides
 * (blockquote / list / listItem) whose own fields are untouched, the walk
 * recurses into the container's children and splices at child granularity —
 * sibling children the edit never touched keep their source bytes even for
 * byte-forms mdast cannot represent (blank-line runs inside a list item).
 *
 * Returns null on parse failure or when any top-level block lacks a
 * position offset (caller falls back to whole-body diff path). The
 * non-contiguous-changes case (paragraph 1 + paragraph 3 edited,
 * paragraph 2 unchanged) still collapses to one over-wide splice covering
 * all three — block-granular degradation in that narrow case.
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

  try {
    return computeChildrenSplice(
      oldChildren,
      newChildren,
      {
        start: oldChildren.length > 0 ? blockStartOffset(oldChildren[0]) : 0,
        end: oldBody.length,
      },
      {
        start: newChildren.length > 0 ? blockStartOffset(newChildren[0]) : 0,
        end: newBody.length,
      },
      newBody,
    );
  } catch (err) {
    // The position guards above (and inside tryNarrowIntoContainer) make
    // offset throws unreachable under current parser behavior, but the
    // caller's contract is MapDrivenSplice | null — an exception here would
    // bypass the fallback telemetry and surface inside the observer drain.
    onFallback?.('missing-position', err);
    return null;
  }
}

interface ByteRegion {
  readonly start: number;
  readonly end: number;
}

/**
 * Node types whose byte-form contains independently-positioned children the
 * splice can narrow into. Leaf blocks (paragraph, heading, code) and table
 * internals (row/cell slices don't re-anchor as standalone source) stay at
 * their own granularity.
 *
 * Admission criteria for a new type: (1) every child carries its own mdast
 * position offsets into the same source string; (2) the container's own
 * byte contribution (markers, indentation) is confined to line prefixes so
 * splicing between child boundaries yields well-formed source; (3) a
 * child-range slice of the canonical serialization stays valid when
 * spliced between preserved old-byte siblings. Types that serialize their
 * children through a bespoke walker (table, commentBlock, JSX containers)
 * fail (2)/(3) and must stay out.
 */
const NARROWABLE_CONTAINER_TYPES = new Set(['blockquote', 'list', 'listItem']);

/**
 * Prefix/suffix walk over one sibling level, emitting the splice for the
 * changed middle region. When the changed region is exactly one node on each
 * side, both of the same narrowable container type, and the containers
 * differ ONLY in their children (own fields incl. `data` equal — a
 * container-level source-form edit like a bullet-marker or marker-spacing
 * change must rewrite the whole container, never be silently dropped),
 * recurse into the children so untouched siblings INSIDE the container keep
 * their source bytes (blank-line runs and other byte-forms mdast cannot
 * represent).
 */
function computeChildrenSplice(
  oldChildren: readonly RootContent[],
  newChildren: readonly RootContent[],
  oldRegion: ByteRegion,
  newRegion: ByteRegion,
  newBody: string,
): MapDrivenSplice {
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

  if (
    oldChildren.length - prefixLen - suffixLen === 1 &&
    newChildren.length - prefixLen - suffixLen === 1
  ) {
    const oldChanged = oldChildren[prefixLen];
    const newChanged = newChildren[prefixLen];
    const narrowed = tryNarrowIntoContainer(oldChanged, newChanged, newBody);
    if (narrowed) return narrowed;
  }

  const spliceStart = prefixLen > 0 ? blockEndOffset(oldChildren[prefixLen - 1]) : oldRegion.start;
  const spliceEnd =
    suffixLen > 0 ? blockStartOffset(oldChildren[oldChildren.length - suffixLen]) : oldRegion.end;

  const newSliceStart =
    prefixLen > 0 ? blockEndOffset(newChildren[prefixLen - 1]) : newRegion.start;
  const newSliceEnd =
    suffixLen > 0 ? blockStartOffset(newChildren[newChildren.length - suffixLen]) : newRegion.end;

  return {
    spliceStart,
    spliceEnd,
    newSlice: newBody.slice(newSliceStart, newSliceEnd),
  };
}

function tryNarrowIntoContainer(
  oldNode: RootContent,
  newNode: RootContent,
  newBody: string,
): MapDrivenSplice | null {
  if (oldNode.type !== newNode.type || !NARROWABLE_CONTAINER_TYPES.has(oldNode.type)) return null;
  if (!('children' in oldNode) || !('children' in newNode)) return null;
  const oldKids = oldNode.children as readonly RootContent[];
  const newKids = newNode.children as readonly RootContent[];
  if (oldKids.length === 0 || newKids.length === 0) return null;
  if (!allBlocksCarryPositions(oldKids) || !allBlocksCarryPositions(newKids)) return null;
  // Recursing is only sound when the difference is confined to the
  // children: compare the containers with children stripped.
  if (
    stringifyIgnorePosition({ ...oldNode, children: [] }) !==
    stringifyIgnorePosition({ ...newNode, children: [] })
  ) {
    return null;
  }
  return computeChildrenSplice(
    oldKids,
    newKids,
    { start: blockStartOffset(oldNode), end: blockEndOffset(oldNode) },
    { start: blockStartOffset(newNode), end: blockEndOffset(newNode) },
    newBody,
  );
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
