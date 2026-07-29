/**
 * Pre-drain discriminator: decide, for a pending fragment-only edit sitting in
 * front of a paired-intake derive (agent undo or agent write), whether it is
 * SAFE to flush that edit through Observer A into Y.Text before the paired
 * transact runs — or whether the flush would launder the operation's own
 * structs and must be declined in favour of the checkpoint floor.
 *
 * The whole module is READ-ONLY: it computes a verdict, mutates nothing. The
 * flush ("pre-drain") and the checkpoint are the caller's job.
 *
 * The decision rests on two spans, both in FM-stripped body byte coordinates:
 *
 *  - the DRAIN REWRITE range — the contiguous body region Observer A would
 *    delete-and-re-author when it flushes the pending fragment content. This is
 *    exactly what `computeMapDrivenBodySplice` returns on `(currentBody,
 *    fragmentJson)`; the drain applies that same splice, so the modelled range
 *    IS the flush's real rewrite, not an approximation.
 *  - the OPERATION TARGET span — the body region the paired op will touch:
 *    for an undo, the byte ranges the top UndoManager StackItem's structs
 *    occupy in the current Y.Text; for an agent write, the seam / removed-hunk
 *    span its composed body implies.
 *
 * If the rewrite range and the target span are disjoint, the flush cannot touch
 * the op's structs and pre-drain is safe. Any substantive intersection means
 * the flush would delete-and-re-author bytes the op depends on (undo-defeat,
 * duplication, seam corruption) — so the discriminator FAILS CLOSED: a null
 * splice, a witness mismatch, a missing target, or a non-whitespace overlap all
 * route to checkpoint, never to pre-drain. Over-wide is always the safe
 * direction — more checkpointing, never more flushing.
 *
 * Localizer choice is load-bearing and non-substitutable. A line-hunk localizer
 * (`diffLinesFast` over the pending content) reports the MINIMAL changed lines,
 * not the drain's rewrite: when pending edits are non-contiguous the drain's
 * block splice collapses over-wide across the untouched blocks between them and
 * launders a target that sits in that gap, while the hunks — being separate —
 * see no overlap and wrongly admit the flush. The splice model is the only
 * localizer that sees what the drain will actually rewrite.
 */

import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type * as Y from 'yjs';
import { ContentString } from 'yjs';
import { walkYTextItems, type YjsStackItemShape } from './agent-activity.ts';
import { computeMapDrivenBodySplice, type MapDrivenSplice } from './map-driven-splice.ts';

/**
 * A half-open byte range `[start, end)` in FM-stripped body coordinates.
 * `start === end` is a zero-width point — an insertion anchor or a tombstone's
 * collapse position, which carries no width but a location.
 */
export interface BodySpan {
  readonly start: number;
  readonly end: number;
}

export type AgentWritePosition = 'append' | 'prepend' | 'replace' | 'patch';

/**
 * Why the discriminator reached its decision. `preDrain` is derivable from the
 * reason, but callers key their routing (flush / checkpoint / no-op) off
 * `preDrain` and use the reason for the loss-ring's content-free correlation.
 *
 * The `skip-*` reasons mean there was nothing to flush (no checkpoint owed); the
 * `checkpoint-*` reasons mean the flush was DECLINED and the paired write's
 * checkpoint floor owns the content instead.
 */
type PreDrainReason =
  | 'skip-disabled'
  | 'skip-no-pending'
  | 'skip-already-converged'
  | 'checkpoint-full-overwrite'
  | 'checkpoint-witness-mismatch'
  | 'checkpoint-null-splice'
  | 'checkpoint-no-target'
  | 'checkpoint-substantive-overlap'
  | 'pre-drain-disjoint'
  | 'pre-drain-whitespace-graze';

export interface PreDrainVerdict {
  /** true → flush the pending fragment content before the paired transact. */
  readonly preDrain: boolean;
  readonly reason: PreDrainReason;
}

/**
 * The core overlap decision, pure over two spans and the current body bytes.
 * No Y.Doc, no parse, no compose — every op-specific input is already resolved
 * to a span. This is where the fail-closed routing and the whitespace-graze
 * relaxation live.
 */
export function classifyPreDrain(
  spliceRange: BodySpan | null,
  targetSpan: BodySpan | null,
  body: string,
): PreDrainVerdict {
  if (spliceRange === null) return { preDrain: false, reason: 'checkpoint-null-splice' };
  if (targetSpan === null) return { preDrain: false, reason: 'checkpoint-no-target' };

  // A zero-width op target (an insertion anchor or a tombstone collapse point)
  // is laundered only when it sits STRICTLY inside the rewrite range. A point
  // exactly on a splice boundary is not inside it — the op's anchor survives an
  // insertion at that boundary — so it is disjoint, not an overlap.
  if (targetSpan.start === targetSpan.end) {
    const p = targetSpan.start;
    return spliceRange.start < p && p < spliceRange.end
      ? { preDrain: false, reason: 'checkpoint-substantive-overlap' }
      : { preDrain: true, reason: 'pre-drain-disjoint' };
  }

  const iStart = Math.max(spliceRange.start, targetSpan.start);
  const iEnd = Math.min(spliceRange.end, targetSpan.end);
  if (iStart >= iEnd) return { preDrain: true, reason: 'pre-drain-disjoint' };

  // Positive-width intersection. Admit it to pre-drain only when its
  // current-body bytes are entirely whitespace — the block-separator newlines
  // at a boundary. A substantive struct the drain would launder necessarily
  // contributes non-whitespace bytes to the intersection, so this graze can
  // only ever admit separator laundering, whose worst case is a parse-invisible
  // blank-line artifact.
  return body.slice(iStart, iEnd).trim() === ''
    ? { preDrain: true, reason: 'pre-drain-whitespace-graze' }
    : { preDrain: false, reason: 'checkpoint-substantive-overlap' };
}

/**
 * Whether a struct's clock range `[clock, clock + len)` overlaps any range the
 * DeleteSet records for that client. Used for tombstones, whose byte position
 * collapses to a single point regardless of how much of the struct the burst
 * covered.
 */
function structOverlapsDeleteSet(
  client: number,
  clock: number,
  len: number,
  ds: YjsStackItemShape['insertions'],
): boolean {
  const ranges = ds.clients.get(client);
  if (ranges === undefined) return false;
  const end = clock + len;
  for (const r of ranges) {
    if (clock < r.clock + r.len && r.clock < end) return true;
  }
  return false;
}

/**
 * The byte sub-ranges of a live struct (at byte `offset`, clock `[clock, clock +
 * len)`) that the DeleteSet covers. yjs merges adjacent same-client structs even
 * across a burst boundary, so a single live item can straddle burst and
 * non-burst content; projecting per DeleteSet range — not per whole item — keeps
 * the target tight to exactly the bytes the burst inserted, rather than widening
 * it over the neighbour it merged with.
 */
function* burstByteSubranges(
  client: number,
  clock: number,
  len: number,
  offset: number,
  ds: YjsStackItemShape['insertions'],
): IterableIterator<readonly [number, number]> {
  const ranges = ds.clients.get(client);
  if (ranges === undefined) return;
  const structEnd = clock + len;
  for (const r of ranges) {
    const oStart = Math.max(clock, r.clock);
    const oEnd = Math.min(structEnd, r.clock + r.len);
    if (oStart < oEnd) yield [offset + (oStart - clock), offset + (oEnd - clock)];
  }
}

/**
 * The undo target span: the bounding body range the top StackItem's structs
 * occupy in the current Y.Text, projected to body coordinates.
 *
 * A single document-order walk of the Y.Text item chain accumulates the visible
 * byte offset. A currently-visible struct in the StackItem's `insertions`
 * (content the undo will delete) contributes the byte sub-ranges the burst
 * actually covers (tight even when yjs has merged it with a neighbour); a
 * tombstoned struct in the `deletions` (content the undo will re-insert)
 * contributes a zero-width collapse point at its current offset. The union's
 * `[min, max)` is the blast radius. Returns null when no struct maps — an empty
 * stack or a frame that touched only the flash map — which routes to checkpoint.
 *
 * Membership is a pure clock-range test rather than yjs's `iterateDeletedStructs`
 * (which the sibling `agent-activity.ts` uses): that primitive needs a live
 * throwaway transaction, and the caller runs this immediately before the paired
 * transact where a stray settlement dispatch could perturb the drain's witness
 * state. The walk itself is the shared `walkYTextItems` donor.
 */
function extractUndoTargetSpan(
  ytext: Y.Text,
  stackItem: YjsStackItemShape,
  fmPrefixLen: number,
): BodySpan | null {
  let offset = 0;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;

  for (const item of walkYTextItems(ytext)) {
    if (!(item.content instanceof ContentString)) continue;
    const { client, clock } = item.id;
    const len = item.content.str.length;
    if (!item.deleted) {
      for (const [subStart, subEnd] of burstByteSubranges(
        client,
        clock,
        len,
        offset,
        stackItem.insertions,
      )) {
        minStart = Math.min(minStart, subStart);
        maxEnd = Math.max(maxEnd, subEnd);
      }
      offset += len;
    } else if (structOverlapsDeleteSet(client, clock, len, stackItem.deletions)) {
      minStart = Math.min(minStart, offset);
      maxEnd = Math.max(maxEnd, offset);
    }
  }

  if (minStart === Number.POSITIVE_INFINITY) return null;
  return { start: Math.max(0, minStart - fmPrefixLen), end: Math.max(0, maxEnd - fmPrefixLen) };
}

/**
 * Write positions whose compose is a FULL-BODY OVERWRITE. `composeAgentWrite`
 * sets `newBody = payloadBody` for BOTH `replace` and `patch` — the agent's
 * payload becomes the entire body — so a flushed keystroke cannot survive the
 * write no matter where in the body it sat. Pre-drain is structurally inert for
 * these: the paired write's checkpoint floor owns the pending content.
 *
 * This is a POSITION gate, deliberately not span arithmetic. Modelling
 * `replace` as the span `[0, body.length)` looks equivalent but is not: the
 * classifier's zero-width-splice and whitespace-graze relaxations both admit a
 * flush against it (a pure block insertion produces exactly a zero-width /
 * whitespace-only intersection at the trailing seam), and the overwrite then
 * reverts the flushed bytes with the loss verdict already satisfied — the flush
 * moved them into the pre-write Y.Text baseline, so the detector sees nothing
 * at risk. Modelling `patch` as its diff'd changed region is worse still: the
 * model and the compose disagree outright.
 */
const FULL_BODY_OVERWRITE_POSITIONS: ReadonlySet<AgentWritePosition> = new Set([
  'replace',
  'patch',
]);

/**
 * The agent-write target span in body coordinates, for the positions whose
 * compose is a localized edit.
 *
 *  - append: the trailing seam `[trimEnd(body).length, body.length)` the append
 *    attaches to.
 *  - prepend: unmeasured; returns null so it fails closed to checkpoint.
 *
 * `replace` / `patch` never reach here — {@link FULL_BODY_OVERWRITE_POSITIONS}
 * declines them before any target extraction.
 */
export function extractComposeTargetSpan(
  body: string,
  writeKind: AgentWritePosition,
): BodySpan | null {
  if (writeKind !== 'append') return null;
  const trimmedLen = body.replace(/\s+$/, '').length;
  return { start: trimmedLen, end: body.length };
}

/**
 * The paired op the discriminator is deciding in front of. An undo carries the
 * live Y.Text plus the top StackItem to map; an agent write carries its position
 * kind, which is what determines both its target span and whether it is a
 * full-body overwrite.
 */
type PreDrainOp =
  | { readonly kind: 'agent-undo'; readonly ytext: Y.Text; readonly stackItem: YjsStackItemShape }
  | { readonly kind: 'agent-write'; readonly writeKind: AgentWritePosition };

export interface DiscriminatePreDrainInput {
  /**
   * The pending-dirty gate: false short-circuits to `skip-no-pending` before any
   * parse, so a clean paired op pays no discriminator cost.
   */
  readonly pendingDirty: boolean;
  /** Current FM-stripped Y.Text body. */
  readonly body: string;
  /** The pending fragment's PM JSON (holds the un-propagated content). */
  readonly fragmentPmJson: JSONContent;
  /**
   * Whether the current Y.Text still equals Observer A's last-synced witness. A
   * mismatch means the drain would take a non-splice path whose rewrite differs
   * from the modelled splice, so the discriminator cannot reason about it and
   * fails closed.
   */
  readonly witnessMatched: boolean;
  /** `currentYText.length - body.length` — the FM prefix, for undo projection. */
  readonly fmPrefixLen: number;
  readonly op: PreDrainOp;
  readonly mdManager: MarkdownManager;
}

/**
 * The paired op a caller hands the pre-drain controller, in the form the caller
 * naturally holds. Undo carries only the top StackItem (the controller supplies
 * the live Y.Text from its own closure); a write carries its position kind. The
 * controller resolves this into a full {@link PreDrainOp} before discriminating.
 */
export type PreDrainOpInput =
  | { readonly kind: 'agent-undo'; readonly stackItem: YjsStackItemShape }
  | { readonly kind: 'agent-write'; readonly writeKind: AgentWritePosition };

/**
 * A per-document pre-drain hook, built inside the observer closure so it owns
 * the fragment/Y.Text/witness state and the cheap pending-dirty gate. A paired
 * write's caller invokes `preDrain(op)` immediately before its own paired
 * transact: when the discriminator proves the pending fragment content is
 * non-overlapping with the op's target, the controller flushes that content
 * into Y.Text (so the paired derive rebuilds over content Y.Text now holds and
 * the keystroke survives); otherwise it declines and the paired write's existing
 * checkpoint floor captures the content instead. Returns the verdict for the
 * caller's content-free loss-ring correlation.
 */
export interface PreDrainController {
  preDrain(op: PreDrainOpInput): PreDrainVerdict;
}

/**
 * The decision AND the bytes that implement it. The controller needs both, and
 * the ~15ms serialize+parse+splice must be paid at most once per dirty paired
 * op — so the plan carries the splice the classification was computed from
 * rather than making the caller recompute it.
 *
 * Discriminated on the top-level `preDrain` flag: it is `true` exactly when the
 * splice is non-null (a flush is authorized) and `false` for every declining or
 * skipping outcome (splice `null`). The illegal `preDrain: true` + `splice: null`
 * state is unrepresentable, so a caller cannot flush on a plan that did not
 * authorize it — the type, not a comment, enforces it, and the consumer narrows
 * `splice` to non-null from `preDrain` alone.
 */
export type PreDrainPlan =
  | { readonly preDrain: true; readonly verdict: PreDrainVerdict; readonly splice: MapDrivenSplice }
  | { readonly preDrain: false; readonly verdict: PreDrainVerdict; readonly splice: null };

/**
 * Compose the gate, witness check, target extraction, localizer, and overlap
 * classifier into one plan. The expensive localizer (three full-document
 * passes) runs only after the cheap fail-closed guards pass and a target span
 * exists — so the no-pending, witness-mismatch, and no-target cases never parse.
 *
 * This is THE pre-drain decision: the controller executes the plan, it does not
 * re-derive one. A second implementation of this ordering would let the corpus
 * bar and the shipped behaviour drift apart silently.
 */
export function planPreDrain(input: DiscriminatePreDrainInput): PreDrainPlan {
  const decline = (reason: PreDrainReason): PreDrainPlan => ({
    preDrain: false,
    verdict: { preDrain: false, reason },
    splice: null,
  });

  if (!input.pendingDirty) return decline('skip-no-pending');
  if (!input.witnessMatched) return decline('checkpoint-witness-mismatch');
  if (input.op.kind === 'agent-write' && FULL_BODY_OVERWRITE_POSITIONS.has(input.op.writeKind)) {
    return decline('checkpoint-full-overwrite');
  }

  const targetSpan =
    input.op.kind === 'agent-undo'
      ? extractUndoTargetSpan(input.op.ytext, input.op.stackItem, input.fmPrefixLen)
      : extractComposeTargetSpan(input.body, input.op.writeKind);
  if (targetSpan === null) return decline('checkpoint-no-target');

  const splice = computeMapDrivenBodySplice(input.body, input.fragmentPmJson, input.mdManager);
  if (splice === null) return decline('checkpoint-null-splice');

  // Already-converged gate. `pendingDirty` only says the fragment MOVED since
  // the last convergence — not that anything is still un-propagated. A drain
  // that propagated everything under freshness suppression leaves the flag set
  // with nothing pending, and the splice model then returns the trailing region
  // of two structurally-identical bodies: applying it is a delete+insert of the
  // bytes already there, i.e. pure CRDT tombstone churn on the user's document
  // for no content gain. A flush that rewrites nothing is not a flush.
  if (splice.newSlice === input.body.slice(splice.spliceStart, splice.spliceEnd)) {
    return decline('skip-already-converged');
  }

  const verdict = classifyPreDrain(
    { start: splice.spliceStart, end: splice.spliceEnd },
    targetSpan,
    input.body,
  );
  return verdict.preDrain
    ? { preDrain: true, verdict, splice }
    : { preDrain: false, verdict, splice: null };
}
