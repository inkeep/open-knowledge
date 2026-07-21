/**
 * Clipboard-omitted content scrub — the non-DOM half of the
 * `data-clipboard-omit` contract.
 *
 * The live-DOM walker (`clipboard-walker.ts`) drops subtrees whose
 * rendered element carries `data-clipboard-omit="true"` (comment mark
 * spans, commentBlock asides). Every other outbound flavor — text/plain,
 * the markdown-tier text/html fallback, the CellSelection table tier —
 * serializes from the PM tree and never sees that DOM attribute, so
 * omitted content leaked through them verbatim. This module gives those
 * PM-tree serializers the same omission semantics, keyed off the SAME
 * declaration: a mark/node type is "clipboard-omitted" when its
 * `spec.toDOM` output stamps `data-clipboard-omit="true"`. Deriving
 * membership from the rendered spec (instead of a hardcoded name list)
 * keeps future opt-in descriptors covered without touching this file.
 *
 * OK→OK travel: scrubbing every standard flavor means no public payload
 * can carry an annotation back into OK. Copy/cut therefore rides the
 * unscrubbed slice markdown on {@link OK_INTERNAL_CLIPBOARD_MIME} (see
 * `handle-copy.ts`), which the paste dispatcher prefers — the
 * BlockNote/Lexical pattern of a private internal flavor with public
 * flavors stripped.
 */

import type { Mark, MarkType, Node, NodeType, Schema, Slice } from '@tiptap/pm/model';
import { Fragment, Slice as SliceCtor } from '@tiptap/pm/model';

/**
 * Private clipboard flavor carrying the copied slice's canonical markdown
 * WITH clipboard-omitted content intact. Written only by the copy/cut
 * intercept when the slice contains omitted content; read first by the
 * paste dispatcher.
 */
export const OK_INTERNAL_CLIPBOARD_MIME = 'application/x-openknowledge-markdown';

const OMIT_ATTR = 'data-clipboard-omit';

interface OmittedTypes {
  marks: Set<MarkType>;
  nodes: Set<NodeType>;
}

const omittedTypesCache = new WeakMap<Schema, OmittedTypes>();

function toDomStampsOmit(spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  const attrs = spec[1];
  return (
    typeof attrs === 'object' &&
    attrs !== null &&
    !Array.isArray(attrs) &&
    (attrs as Record<string, unknown>)[OMIT_ATTR] === 'true'
  );
}

/**
 * The schema's clipboard-omitted mark/node types, derived once per schema
 * by probing each type's `spec.toDOM` output for the omit attribute. A
 * `toDOM` probe throw (a type whose renderer needs richer context than a
 * bare instance) counts as not-omitted — fail open to "keep the content",
 * never to "drop user content".
 */
function getClipboardOmittedTypes(schema: Schema): OmittedTypes {
  const cached = omittedTypesCache.get(schema);
  if (cached) return cached;
  const result: OmittedTypes = { marks: new Set(), nodes: new Set() };
  for (const markType of Object.values(schema.marks)) {
    try {
      const mark = markType.create();
      if (toDomStampsOmit(markType.spec.toDOM?.(mark, true))) result.marks.add(markType);
    } catch {
      // not omitted
    }
  }
  for (const nodeType of Object.values(schema.nodes)) {
    try {
      const node = nodeType.createAndFill();
      if (node && toDomStampsOmit(nodeType.spec.toDOM?.(node))) result.nodes.add(nodeType);
    } catch {
      // not omitted
    }
  }
  omittedTypesCache.set(schema, result);
  return result;
}

function isOmittedNode(node: Node, omitted: OmittedTypes): boolean {
  if (omitted.nodes.has(node.type)) return true;
  return node.marks.some((mark: Mark) => omitted.marks.has(mark.type));
}

function scrubFragment(fragment: Fragment, omitted: OmittedTypes): Fragment {
  const out: Node[] = [];
  let changed = false;
  fragment.forEach((child) => {
    if (isOmittedNode(child, omitted)) {
      changed = true;
      return;
    }
    const scrubbedContent = scrubFragment(child.content, omitted);
    if (scrubbedContent !== child.content) {
      changed = true;
      out.push(child.copy(scrubbedContent));
    } else {
      out.push(child);
    }
  });
  return changed ? Fragment.fromArray(out) : fragment;
}

/** True when any node in the fragment is clipboard-omitted (or carries an omitted mark). */
function fragmentContainsOmitted(fragment: Fragment, omitted: OmittedTypes): boolean {
  let found = false;
  fragment.forEach((child) => {
    if (found) return;
    if (isOmittedNode(child, omitted) || fragmentContainsOmitted(child.content, omitted)) {
      found = true;
    }
  });
  return found;
}

export function sliceContainsClipboardOmitted(slice: Slice, schema: Schema): boolean {
  const omitted = getClipboardOmittedTypes(schema);
  if (omitted.marks.size === 0 && omitted.nodes.size === 0) return false;
  return fragmentContainsOmitted(slice.content, omitted);
}

/** Depth of the open-node chain reachable from the fragment's edge. */
function maxOpenDepth(fragment: Fragment, side: 'first' | 'last'): number {
  let depth = 0;
  let node = side === 'first' ? fragment.firstChild : fragment.lastChild;
  while (node && !node.isLeaf) {
    depth += 1;
    node = side === 'first' ? node.firstChild : node.lastChild;
  }
  return depth;
}

/**
 * A copy of `slice` with clipboard-omitted content removed. Emptied
 * wrapper blocks are kept (an inline-comment-only paragraph scrubs to an
 * empty paragraph — matching the walker's rendering of the same
 * selection). Open depths are clamped in the corner where a dropped edge
 * node shortened the open chain.
 */
export function stripClipboardOmitted(slice: Slice, schema: Schema): Slice {
  const omitted = getClipboardOmittedTypes(schema);
  if (omitted.marks.size === 0 && omitted.nodes.size === 0) return slice;
  const scrubbed = scrubFragment(slice.content, omitted);
  if (scrubbed === slice.content) return slice;
  const openStart = Math.min(slice.openStart, maxOpenDepth(scrubbed, 'first'));
  const openEnd = Math.min(slice.openEnd, maxOpenDepth(scrubbed, 'last'));
  return new SliceCtor(scrubbed, openStart, openEnd);
}

/** Node-level scrub for the TSV cell path (returns the node unchanged when clean). */
export function stripClipboardOmittedFromNode(node: Node, schema: Schema): Node {
  const omitted = getClipboardOmittedTypes(schema);
  if (omitted.marks.size === 0 && omitted.nodes.size === 0) return node;
  const scrubbed = scrubFragment(node.content, omitted);
  return scrubbed === node.content ? node : node.copy(scrubbed);
}

/** Fragment-level scrub for the CellSelection table tier. */
export function stripClipboardOmittedFromFragment(fragment: Fragment, schema: Schema): Fragment {
  const omitted = getClipboardOmittedTypes(schema);
  if (omitted.marks.size === 0 && omitted.nodes.size === 0) return fragment;
  return scrubFragment(fragment, omitted);
}
