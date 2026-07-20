/**
 * `buildRenderedDiff` — the pure diff engine behind the Timeline's rendered
 * (WYSIWYG) diff. Given two markdown bodies + a schema, it returns the "after"
 * ProseMirror document plus the word-level change ranges between the two
 * versions, ready for the decoration builder (`diff-decorations.ts`) to paint.
 *
 * Pure + deterministic: no DOM, no I/O. `beforeDoc` is returned alongside so
 * the decoration builder can slice removed content out of it for deletion
 * widgets. Callers guard with `ok` — a `false` return (parse/recreate failure,
 * or over the size/change ceiling) signals the pane to fall back to the raw
 * Source diff rather than render a broken or pathologically slow view.
 */

import { recreateTransform } from '@fellow/prosemirror-recreate-transform';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { AddMarkStep, RemoveMarkStep, type Transform } from '@tiptap/pm/transform';
import { buildBlockChanges, type SpanChange } from './block-diff';

export type { SpanChange } from './block-diff';

/**
 * Above this the rendered diff is skipped in favor of the Source view: a huge
 * doc or a huge edit distance makes `recreateTransform` slow and its output
 * noisy. Deliberately generous — most timeline docs sit far below it.
 */
export const RENDERED_DIFF_SIZE_CEILING = 200_000;
const RENDERED_DIFF_CHANGE_CEILING = 400;

/**
 * A formatting-only change (mark added or removed) with no accompanying text
 * change — e.g. bolding a word or removing a link. The block-level content diff
 * is position-based and a mark step changes no positions, so these are surfaced
 * separately (from the transform's mark steps) and rendered like a replacement:
 * the BEFORE form (old marks) struck through in red, the AFTER form (new marks)
 * highlighted in green. `fromA/toA` index the before doc (the struck slice);
 * `fromB/toB` index the after doc (the highlighted range).
 */
export interface MarkChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  /** Schema mark name, e.g. `strong`, `em`, `link`, `code`. */
  markName: string;
  kind: 'add' | 'remove';
}

export interface RenderedDiff {
  ok: true;
  /** The "after" version, rendered as the document. */
  afterDoc: PMNode;
  /** The "before" version — deletion widgets slice removed content from it. */
  beforeDoc: PMNode;
  /** Block-level added/removed ranges, old + new coordinates. */
  changes: readonly SpanChange[];
  /** Formatting-only (mark add/remove) ranges in after-doc coordinates. */
  markChanges: readonly MarkChange[];
}

interface RenderedDiffFailure {
  ok: false;
  reason: 'parse' | 'recreate' | 'ceiling';
}

export type RenderedDiffResult = RenderedDiff | RenderedDiffFailure;

function toDoc(md: MarkdownManager, schema: Schema, body: string): PMNode {
  // parseWithFallback (not parse): historical on-disk bytes are untrusted and
  // may carry a schema-hostile construct; the fallback substitutes a raw node
  // instead of throwing into the caller.
  return schema.nodeFromJSON(md.parseWithFallback(body));
}

/**
 * Pull formatting-only changes out of the recreated transform. `recreateTransform`
 * with `complexSteps` emits clean `addMark`/`removeMark` steps (a bold toggle is
 * one such step carrying the text range + mark type). These change no positions,
 * so the block-level content diff can't see them — we read them here. Each step's
 * range is mapped both forward (through the later steps → after-doc coords,
 * `fromB/toB`) and backward (through the earlier steps, inverted → before-doc
 * coords, `fromA/toA`). A mark range fully inside an inserted content range is
 * dropped: newly inserted text is already highlighted as an insertion, so its
 * formatting is not a separate signal.
 */
function collectMarkChanges(tr: Transform, changes: readonly SpanChange[]): MarkChange[] {
  const inserted = changes.filter((c) => c.toB > c.fromB);
  const out: MarkChange[] = [];
  tr.steps.forEach((step, i) => {
    const kind =
      step instanceof AddMarkStep ? 'add' : step instanceof RemoveMarkStep ? 'remove' : null;
    if (kind === null) return;
    const markStep = step as AddMarkStep | RemoveMarkStep;
    const forward = tr.mapping.slice(i + 1);
    const fromB = forward.map(markStep.from, -1);
    const toB = forward.map(markStep.to, 1);
    if (toB <= fromB) return;
    if (inserted.some((c) => c.fromB <= fromB && toB <= c.toB)) return;
    const backward = tr.mapping.slice(0, i).invert();
    const fromA = backward.map(markStep.from);
    const toA = backward.map(markStep.to);
    if (toA <= fromA) return;
    out.push({ fromA, toA, fromB, toB, markName: markStep.mark.type.name, kind });
  });
  return out;
}

/**
 * Compute the rendered diff between two markdown bodies. `before`/`after` are
 * the frontmatter-stripped historical bodies (from `useTimelineEntryDiff`).
 */
export function buildRenderedDiff(
  before: string,
  after: string,
  schema: Schema,
  md: MarkdownManager,
): RenderedDiffResult {
  if (before.length > RENDERED_DIFF_SIZE_CEILING || after.length > RENDERED_DIFF_SIZE_CEILING) {
    return { ok: false, reason: 'ceiling' };
  }

  let beforeDoc: PMNode;
  let afterDoc: PMNode;
  try {
    beforeDoc = toDoc(md, schema, before);
    afterDoc = toDoc(md, schema, after);
  } catch {
    return { ok: false, reason: 'parse' };
  }

  // Formatting-only changes come from the word-level transform (mark steps); the
  // content diff is block-level. The transform is best-effort: if it throws on a
  // pathological pair we still render the block diff, just without mark changes.
  let renderDoc = afterDoc;
  let tr: Transform | null = null;
  try {
    // complexSteps: allow non-Replace (mark) steps so bold/link toggles surface;
    // wordDiffs keeps a mark step's range tight; simplifyDiff merges adjacent.
    tr = recreateTransform(beforeDoc, afterDoc, {
      complexSteps: true,
      wordDiffs: true,
      simplifyDiff: true,
    });
    renderDoc = tr.doc;
  } catch {
    // Keep the parsed afterDoc as the render target; drop mark changes.
  }

  // Compute block ranges against the doc we actually render (renderDoc), not the
  // pre-transform afterDoc — so a decoration boundary can never be invalid even
  // if `recreateTransform` normalized the structure. Mark ranges map into the
  // same coordinate space, and dedup against the block insertions.
  const contentChanges = buildBlockChanges(beforeDoc, renderDoc);
  const markChanges = tr ? collectMarkChanges(tr, contentChanges) : [];

  if (contentChanges.length + markChanges.length > RENDERED_DIFF_CHANGE_CEILING) {
    return { ok: false, reason: 'ceiling' };
  }
  return { ok: true, afterDoc: renderDoc, beforeDoc, changes: contentChanges, markChanges };
}
