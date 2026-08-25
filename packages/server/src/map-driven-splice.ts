/**
 * Block-aligned splice computer for the map-driven Observer A path.
 *
 * Given the current body bytes (`oldBody`) and the new PM JSON (from
 * XmlFragment), compute ONE contiguous source-byte splice that rewrites
 * only the portion of the body whose top-level mdast blocks differ
 * structurally between old and new. Untouched prefix + suffix blocks
 * stay in Y.Text byte-identical.
 *
 * The computation touches no Y.Doc and no observers, and its RESULT is a pure
 * function of its inputs. It is not side-effect-free: when a `memo` is passed
 * it writes the parse it just performed into that memo. The write is
 * cache-only — it can change how long a later call takes, never what any call
 * returns — but "pure, no side effects" would now be a false claim, and the
 * distinction matters to anyone reasoning about calling this concurrently.
 *
 * Shape: parse oldBody → mdast, serialize new PM JSON → canonical newBody,
 * parse that → mdast, then walk the two tree.children sequences to find the
 * longest common prefix + suffix under structural equality (position
 * stripped) and emit splice = [oldPrefixEnd, oldSuffixStart] replaced by
 * newBody.slice(newPrefixEnd, newSuffixStart).
 *
 * "Structural equality" ignores `position` so a block whose authored bytes
 * differ from what the serializer would emit (a paragraph carrying a trailing
 * whitespace run, say: `one   ` serializes to `one`) is treated as equal —
 * the OLD bytes survive in Y.Text untouched.
 *
 * Perf envelope: TWO full-document passes per drain-settle when the `memo`
 * hits (serialize + one parse), three when it misses. Synchronous, unbounded
 * by doc size. On a 231 KB document this function is ~87% of Observer A's
 * per-keystroke drain cost; on a 675 KB fuzz document, hundreds of ms per
 * drain. That is acceptable for the settle path — it replaces incremental-diff
 * work of similar order — but it is where large-doc drain latency lives, which
 * an earlier revision of this docblock predicted before anyone measured it.
 *
 * The pass the memo removes is the `oldBody` parse. Across consecutive drains
 * the `oldBody` handed in is byte-identical to the `newBody` the PREVIOUS
 * drain parsed, because the splice that drain applied left Y.Text holding
 * exactly those bytes (see `EditorMdastMemo`).
 *
 * That byte-identity is CONDITIONAL, and the condition is worth stating because
 * it is the whole reason the saving is real: the splice deliberately preserves
 * the OLD bytes outside the changed region, so the drain's result equals its
 * canonical `newBody` only when those preserved bytes are what the serializer
 * would itself emit. Measured: a body whose preserved region round-trips
 * byte-exact hits on the next drain (1 parse); the same shape carrying trailing
 * whitespace misses (2 parses), because the preserved run survives into Y.Text
 * while `newBody` has it stripped. The hit is the normal case: this pipeline
 * preserves an unusually wide class byte-exact — emphasis markers (`*italic*`,
 * `_italic_`, `**bold**`, `__bold__` all survive as authored), setext headings,
 * multi-blank runs, unpadded tables, `+` bullets, indented code, a heading
 * tight against its paragraph — so the miss class is essentially dirty bytes
 * (trailing whitespace, CRLF, a missing final newline). A document full of
 * those pays both parses on every drain, correctly and silently: a miss is only
 * ever slower, never wrong.
 *
 * The surviving serialize + parse are still O(document) and unbounded by doc
 * size. The parse needs a real incremental parser to shrink. The SERIALIZE is
 * NOT irreducible, and saying so would send the next investigator at a hard
 * problem while an easy one sits upstream: Observer A already serialized this
 * same PM JSON before calling here (the `body` it derives for the
 * composition), so a caller-supplied `newBody` would drop this call entirely.
 * Measured at ~37 ms on the 231 KB fixture.
 *
 * It is not threaded through because the two are not always the same string.
 * The caller passes `skipFreshnessDerive: !freshnessSafe`; this call passes no
 * options. Measured against the server manager (which sets
 * `deriveStructuralFreshness`, so the flag is live): on a quiescent drain the
 * two are byte-identical, but on a non-quiescent one they diverge — a
 * diverged-but-pristine `jsxComponent` emits stale `sourceRaw` for the caller
 * and freshly re-derived bytes here (50 vs 51 bytes on a `<Callout>` whose body
 * text was edited away from the `sourceRaw` its pristine fast path still holds,
 * the shape a `.private.` freshness fixture exercises). WHICH side of that
 * divergence is the hazard is not settled here, and the next reader should
 * inherit the question rather than one answer: the caller's suppressed string
 * is knowingly historical, while `SerializeCallOptions` names this splice's own
 * text-match as a convergence mechanism and assigns the risk to the unsuppressed
 * side. What this call site actually needs is only that the two are not
 * interchangeable. Threading the caller's string in only
 * when `freshnessSafe` holds would settle it, but it couples this otherwise
 * input-only computation to the observer's freshness state on the bridge's
 * highest-risk path, so it wants its own fuzz run rather than a ride on
 * someone else's.
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
import type { Root, RootContent } from 'mdast';

export interface MapDrivenSplice {
  readonly spliceStart: number;
  readonly spliceEnd: number;
  readonly newSlice: string;
}

/**
 * One-entry parse memo for the splice computer, owned per-document by the
 * Observer A closure (created at attach, dropped at detach) so two documents
 * editing concurrently never evict each other and nothing outlives the
 * observers.
 *
 * The key is the body BYTES, not a generation counter or a doc revision, and
 * that is the whole safety argument: a hit is only ever returned for a string
 * equal to the one that produced the tree, so an external write, a reconnect
 * resync, or a concurrent client that changes the body out from under the memo
 * simply misses and re-parses. There is no state under which a stale tree can
 * be served — the failure mode of a wrong splice is far worse than the latency
 * this saves, so the memo is designed to have no such mode rather than to
 * detect one. The one thing the key does NOT carry is parse configuration, so
 * a memo is scoped to a single `MarkdownManager`: sharing one across managers
 * configured differently would let a content hit serve a tree the other
 * manager would not have produced.
 *
 * Safe to share the returned tree because the splice walk never mutates it:
 * every consumer either reads `position` offsets or compares via
 * `stringifyIgnorePosition`, and `tryNarrowIntoContainer` spreads into a fresh
 * object rather than editing in place. No tree escapes the computer either —
 * `MapDrivenSplice` carries two numbers and a string.
 *
 * Retained cost, since latency is not the only budget: one entry holds an
 * mdast tree plus its body string, measured at 2.57 MB for a 231 KB body
 * (~11.6x the bytes). Before this memo those trees were transient. For
 * proportion, the loaded Y.Doc for that same content already retains 6.1 MB
 * (~27.6x) in its XmlFragment and Y.Text, so a memoized document costs about
 * 42% more than it did — a fraction of an already-large per-document
 * retention, not a new order of magnitude. It is charged only for documents
 * with observers attached and is released on detach.
 *
 * Deliberately NOT bounded by body size. The saving scales with document size,
 * so a size cap would decline exactly the documents where a drain costs the
 * most — paying full latency to save the memory on the worst case is the wrong
 * trade. If a bound is ever wanted, the memo already degrades to a miss, so
 * declining to store is a one-line change that costs only the parse it was
 * saving.
 */
export interface EditorMdastMemo {
  /**
   * The single entry, or `null` when empty. Body and tree live together in one
   * nullable rather than as two independent ones so that "half-populated" —
   * a body with no tree, or a tree with no body to key it — cannot be
   * constructed. The invariant is both-or-neither, so it is spelled that way.
   */
  entry: { readonly body: string; readonly tree: Root } | null;
}

/** Fresh, empty memo. One per document. */
export function createEditorMdastMemo(): EditorMdastMemo {
  return { entry: null };
}

function parseEditorMdastMemoized(
  mdManager: MarkdownManager,
  body: string,
  memo: EditorMdastMemo | undefined,
): Root {
  if (memo?.entry?.body === body) return memo.entry.tree;
  const tree = mdManager.parseToEditorMdast(body);
  if (memo !== undefined) memo.entry = { body, tree };
  return tree;
}

export function computeMapDrivenBodySplice(
  oldBody: string,
  newPmJson: JSONContent,
  mdManager: MarkdownManager,
  onFallback?: (reason: 'parse-error' | 'missing-position', err?: unknown) => void,
  memo?: EditorMdastMemo,
): MapDrivenSplice | null {
  let oldChildren: readonly RootContent[];
  let newBody: string;
  let newChildren: readonly RootContent[];
  try {
    // The editor view on both sides: a blank-line run between two blocks is
    // a paragraph in the PM document but pure gap bytes to a CommonMark
    // parse, so the sibling walk below would see two identical block lists
    // and splice a byte range that excludes the very change it is meant to
    // carry.
    // Memo order matters: `oldBody` is looked up FIRST because it is the
    // side that repeats across drains, then `newBody` overwrites the single
    // slot so the NEXT drain's `oldBody` lookup hits.
    oldChildren = parseEditorMdastMemoized(mdManager, oldBody, memo).children;
    newBody = mdManager.serialize(newPmJson);
    newChildren = parseEditorMdastMemoized(mdManager, newBody, memo).children;
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
