/**
 * `buildDiffDecorations` — turns the engine's change ranges into a ProseMirror
 * `DecorationSet` painted over the rendered "after" document:
 *
 *   - Inserted blocks (`toB > fromB`) → node decoration (`ok-diff-ins-block`)
 *     over the whole added block: highlighted in place.
 *   - Deleted blocks (`toA > fromA`) → a widget decoration at `fromB` whose DOM
 *     is the removed slice of the BEFORE doc, serialized through the real schema
 *     (`DOMSerializer`) so a removed heading/list/code renders formatted, then
 *     struck through (`ok-diff-del`). A reworded block is both at once — the
 *     struck old block (side −1) then the highlighted new block — reading
 *     "~~old~~ new" like a text replacement.
 *   - Mark changes (formatting-only, e.g. bold/link added or removed) → rendered
 *     as a replacement: the before-doc slice (old marks) as a struck `ok-diff-del`
 *     widget, plus an inline `ok-diff-ins` highlight over the after range. Reuses
 *     the same machinery so formatting reads like any other diff.
 *
 * Open-slice handling: deleting list items yields
 * an OPEN slice — bare `<li>` with no enclosing `<ul>`, so markers wouldn't
 * render. When every top-level child of the removed fragment is a list item we
 * re-wrap the serialized output in a `<ul>` so the removed list reads as a
 * list. Other open slices render as-is (acceptable for v1).
 *
 * Static by construction: the diff document never changes (read-only), so the
 * set is built once and needs no mapping across transactions.
 */
import { DOMSerializer, type Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { MarkChange, SpanChange } from './build-rendered-diff';

/**
 * Every change anchor this module paints: an inline insertion/mark highlight
 * (`ok-diff-ins`), a whole-block insertion highlight (`ok-diff-ins-block`), or a
 * deletion widget (`data-diff-deleted`). The pane's scroll-to-first-change and
 * prev/next stepper query by this exact selector — keep it the single source so
 * a new decoration class can't silently fall out of navigation.
 */
export const RENDERED_DIFF_CHANGE_SELECTOR =
  '.ok-diff-ins, .ok-diff-ins-block, [data-diff-deleted]';

/**
 * Number of DOM elements `buildDiffDecorations` paints that match
 * `RENDERED_DIFF_CHANGE_SELECTOR` — the count the change stepper navigates.
 * Kept next to the builder so the two can't drift: a content change is one
 * element (an `ok-diff-ins-block` node OR a `data-diff-deleted` widget), a mark
 * change is TWO (the struck before-form widget PLUS the highlighted after-form
 * inline). The stepper's "N / M" must use THIS, not `changes.length +
 * markChanges.length`, or M undercounts the real anchors by `markChanges.length`.
 */
export function countRenderedDiffAnchors(diff: {
  changes: readonly SpanChange[];
  markChanges: readonly MarkChange[];
}): number {
  return diff.changes.length + 2 * diff.markChanges.length;
}

function fragmentHasBlock(frag: Fragment): boolean {
  let hasBlock = false;
  frag.forEach((child) => {
    if (child.isBlock) hasBlock = true;
  });
  return hasBlock;
}

/** True when every top-level child is a list item — the open-slice rewrap case. */
function isAllListItems(frag: Fragment): boolean {
  if (frag.childCount === 0) return false;
  let all = true;
  frag.forEach((child) => {
    if (child.type.name !== 'listItem' && child.type.name !== 'taskItem') all = false;
  });
  return all;
}

function buildDeletedWidget(
  serializer: DOMSerializer,
  content: Fragment,
  isBlock: boolean,
): HTMLElement {
  const host = document.createElement(isBlock ? 'div' : 'span');
  host.className = isBlock ? 'ok-diff-del ok-diff-del-block' : 'ok-diff-del';
  host.setAttribute('data-diff-deleted', '');
  const rendered = serializer.serializeFragment(content);
  if (isBlock && isAllListItems(content)) {
    const ul = document.createElement('ul');
    ul.appendChild(rendered);
    host.appendChild(ul);
  } else {
    host.appendChild(rendered);
  }
  return host;
}

/**
 * Build the decoration set for a rendered diff. `afterDoc` is the rendered
 * document (the set is anchored to it); `beforeDoc` supplies removed content;
 * `changes` come from `buildRenderedDiff`.
 */
export function buildDiffDecorations(
  afterDoc: PMNode,
  beforeDoc: PMNode,
  changes: readonly SpanChange[],
  markChanges: readonly MarkChange[],
  schema: Schema,
): DecorationSet {
  const serializer = DOMSerializer.fromSchema(schema);
  const decorations: Decoration[] = [];

  // Formatting-only changes render like a replacement: the BEFORE form (old
  // marks — e.g. still bold) struck through in red as a widget, the AFTER form
  // (new marks) highlighted green in place. Same machinery as a text replace, so
  // "bold removed" reads as ~~**text**~~ text, consistent with content diffs.
  for (const mark of markChanges) {
    const slice = beforeDoc.slice(mark.fromA, mark.toA);
    const isBlock = fragmentHasBlock(slice.content);
    decorations.push(
      Decoration.widget(mark.fromB, () => buildDeletedWidget(serializer, slice.content, isBlock), {
        side: -1,
        ignoreSelection: true,
        marks: [],
      }),
    );
    decorations.push(
      Decoration.inline(mark.fromB, mark.toB, { class: 'ok-diff-ins' }, { inclusiveEnd: true }),
    );
  }

  for (const change of changes) {
    if (change.toB > change.fromB) {
      // Whole added block → node decoration so the block's own DOM element
      // (`<li>`, `<p>`, `<h2>`…) carries the highlight, rather than an inline
      // span that can't straddle block boundaries cleanly.
      decorations.push(Decoration.node(change.fromB, change.toB, { class: 'ok-diff-ins-block' }));
    }
    if (change.toA > change.fromA) {
      const slice = beforeDoc.slice(change.fromA, change.toA);
      const isBlock = fragmentHasBlock(slice.content);
      decorations.push(
        Decoration.widget(
          change.fromB,
          () => buildDeletedWidget(serializer, slice.content, isBlock),
          // side −1 so the removed content renders BEFORE any inserted range
          // at the same position (reads "~~old~~ new"). `ignoreSelection` +
          // no marks: it is inert chrome, not part of the document.
          { side: -1, ignoreSelection: true, marks: [] },
        ),
      );
    }
  }

  return DecorationSet.create(afterDoc, decorations);
}
