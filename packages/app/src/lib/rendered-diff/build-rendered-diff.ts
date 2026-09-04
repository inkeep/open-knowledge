import { recreateTransform } from '@fellow/prosemirror-recreate-transform';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { AddMarkStep, RemoveMarkStep, type Transform } from '@tiptap/pm/transform';
import { buildBlockChanges, type SpanChange } from './block-diff';

export type { SpanChange } from './block-diff';

export const RENDERED_DIFF_SIZE_CEILING = 200_000;
const RENDERED_DIFF_CHANGE_CEILING = 400;

export interface MarkChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  markName: string;
  kind: 'add' | 'remove';
}

export interface RenderedDiff {
  ok: true;
  afterDoc: PMNode;
  beforeDoc: PMNode;
  changes: readonly SpanChange[];
  markChanges: readonly MarkChange[];
}

interface RenderedDiffFailure {
  ok: false;
  reason: 'parse' | 'recreate' | 'ceiling';
}

export type RenderedDiffResult = RenderedDiff | RenderedDiffFailure;

function toDoc(md: MarkdownManager, schema: Schema, body: string): PMNode {
  return schema.nodeFromJSON(md.parseWithFallback(body));
}

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

  let renderDoc = afterDoc;
  let tr: Transform | null = null;
  try {
    tr = recreateTransform(beforeDoc, afterDoc, {
      complexSteps: true,
      wordDiffs: true,
      simplifyDiff: true,
    });
    renderDoc = tr.doc;
  } catch {}

  const contentChanges = buildBlockChanges(beforeDoc, renderDoc);
  const markChanges = tr ? collectMarkChanges(tr, contentChanges) : [];

  if (contentChanges.length + markChanges.length > RENDERED_DIFF_CHANGE_CEILING) {
    return { ok: false, reason: 'ceiling' };
  }
  return { ok: true, afterDoc: renderDoc, beforeDoc, changes: contentChanges, markChanges };
}
