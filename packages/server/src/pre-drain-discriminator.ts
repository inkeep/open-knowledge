import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type * as Y from 'yjs';
import { ContentString } from 'yjs';
import { walkYTextItems, type YjsStackItemShape } from './agent-activity.ts';
import { computeMapDrivenBodySplice, type MapDrivenSplice } from './map-driven-splice.ts';

export interface BodySpan {
  readonly start: number;
  readonly end: number;
}

export type AgentWritePosition = 'append' | 'prepend' | 'replace' | 'patch';

type PreDrainReason =
  | 'skip-disabled'
  | 'skip-no-pending'
  | 'skip-already-converged'
  | 'checkpoint-full-overwrite'
  | 'checkpoint-witness-mismatch'
  | 'checkpoint-null-splice'
  | 'checkpoint-no-target'
  | 'checkpoint-fm-ambiguous'
  | 'checkpoint-substantive-overlap'
  | 'pre-drain-disjoint'
  | 'pre-drain-whitespace-graze';

export interface PreDrainVerdict {
  readonly preDrain: boolean;
  readonly reason: PreDrainReason;
}

export function classifyPreDrain(
  spliceRange: BodySpan | null,
  targetSpan: BodySpan | null,
  body: string,
): PreDrainVerdict {
  if (spliceRange === null) return { preDrain: false, reason: 'checkpoint-null-splice' };
  if (targetSpan === null) return { preDrain: false, reason: 'checkpoint-no-target' };

  if (targetSpan.start === targetSpan.end) {
    const p = targetSpan.start;
    return spliceRange.start < p && p < spliceRange.end
      ? { preDrain: false, reason: 'checkpoint-substantive-overlap' }
      : { preDrain: true, reason: 'pre-drain-disjoint' };
  }

  const iStart = Math.max(spliceRange.start, targetSpan.start);
  const iEnd = Math.min(spliceRange.end, targetSpan.end);
  if (iStart >= iEnd) return { preDrain: true, reason: 'pre-drain-disjoint' };

  return body.slice(iStart, iEnd).trim() === ''
    ? { preDrain: true, reason: 'pre-drain-whitespace-graze' }
    : { preDrain: false, reason: 'checkpoint-substantive-overlap' };
}

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

const FULL_BODY_OVERWRITE_POSITIONS: ReadonlySet<AgentWritePosition> = new Set([
  'replace',
  'patch',
]);

export function extractComposeTargetSpan(
  body: string,
  writeKind: AgentWritePosition,
): BodySpan | null {
  if (writeKind !== 'append') return null;
  const trimmedLen = body.replace(/\s+$/, '').length;
  return { start: trimmedLen, end: body.length };
}

type PreDrainOp =
  | { readonly kind: 'agent-undo'; readonly ytext: Y.Text; readonly stackItem: YjsStackItemShape }
  | { readonly kind: 'agent-write'; readonly writeKind: AgentWritePosition };

export interface DiscriminatePreDrainInput {
  readonly pendingDirty: boolean;
  readonly body: string;
  readonly fragmentPmJson: JSONContent;
  readonly witnessMatched: boolean;
  readonly fmPrefixLen: number;
  readonly op: PreDrainOp;
  readonly mdManager: MarkdownManager;
}

export type PreDrainOpInput =
  | { readonly kind: 'agent-undo'; readonly stackItem: YjsStackItemShape }
  | { readonly kind: 'agent-write'; readonly writeKind: AgentWritePosition };

export interface PreDrainController {
  preDrain(op: PreDrainOpInput): PreDrainVerdict;
}

export type PreDrainPlan =
  | { readonly preDrain: true; readonly verdict: PreDrainVerdict; readonly splice: MapDrivenSplice }
  | { readonly preDrain: false; readonly verdict: PreDrainVerdict; readonly splice: null };

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
