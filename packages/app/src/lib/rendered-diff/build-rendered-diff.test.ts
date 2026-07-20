/**
 * Unit tests for the rendered-diff engine — pure, no DOM. Exercises the
 * block-level content diff plus the mark-change pass (from `recreate-transform`)
 * against the shared markdown schema (core `sharedExtensions`, node-safe) and
 * asserts the resulting block/mark ranges.
 */

import { describe, expect, test } from 'bun:test';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import {
  buildRenderedDiff,
  RENDERED_DIFF_SIZE_CEILING,
  type RenderedDiff,
  type SpanChange,
} from './build-rendered-diff';

const schema = getSchema(sharedExtensions);
const md = new MarkdownManager({ extensions: sharedExtensions });

function ok(before: string, after: string): RenderedDiff {
  const r = buildRenderedDiff(before, after, schema, md);
  if (!r.ok) throw new Error(`expected ok, got failure: ${r.reason}`);
  return r;
}

function counts(changes: readonly SpanChange[]): { ins: number; del: number } {
  let ins = 0;
  let del = 0;
  for (const c of changes) {
    if (c.toB > c.fromB) ins++;
    if (c.toA > c.fromA) del++;
  }
  return { ins, del };
}

describe('buildRenderedDiff', () => {
  test('no change → ok with zero changes', () => {
    const r = ok('# Title\n\nSame body.', '# Title\n\nSame body.');
    expect(r.changes.length).toBe(0);
  });

  test('pure insertion → an inserted range, no deletion', () => {
    const r = ok('Alpha.\n\nBeta.', 'Alpha.\n\nBeta.\n\nGamma.');
    const { ins, del } = counts(r.changes);
    expect(ins).toBeGreaterThan(0);
    expect(del).toBe(0);
  });

  test('pure deletion → a deleted range, no insertion', () => {
    const r = ok('Alpha.\n\nBeta.\n\nGamma.', 'Alpha.\n\nGamma.');
    const { ins, del } = counts(r.changes);
    expect(del).toBeGreaterThan(0);
    expect(ins).toBe(0);
  });

  test('word replacement → both an insertion and a deletion', () => {
    const r = ok('The north star guides us.', 'The polar star guides us.');
    const { ins, del } = counts(r.changes);
    expect(ins).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(0);
  });

  test('reconstructed after-doc round-trips the after body', () => {
    const before = '# H\n\none';
    const after = '# H\n\none\n\ntwo';
    const r = ok(before, after);
    // afterDoc is the recreated target; serializing it back yields the after body.
    expect(md.serialize(r.afterDoc.toJSON()).trim()).toBe(after.trim());
  });

  test('over the size ceiling → ok:false (source fallback)', () => {
    const huge = 'x'.repeat(RENDERED_DIFF_SIZE_CEILING + 1);
    const r = buildRenderedDiff(huge, `${huge}!`, schema, md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ceiling');
  });

  test('no change → no mark changes either', () => {
    const r = ok('**Bold** and plain.', '**Bold** and plain.');
    expect(r.markChanges.length).toBe(0);
  });

  test('bold removed (text unchanged) → a remove mark change, no content change', () => {
    const r = ok('one **two three** four', 'one two three four');
    expect(r.changes.length).toBe(0);
    expect(r.markChanges.length).toBe(1);
    const [mc] = r.markChanges;
    expect(mc.kind).toBe('remove');
    expect(mc.markName).toBe('strong');
    expect(mc.toB).toBeGreaterThan(mc.fromB);
    // Pure mark change (no content edits) → before/after coords coincide.
    expect(mc.fromA).toBe(mc.fromB);
    expect(mc.toA).toBe(mc.toB);
  });

  test('bold added (text unchanged) → an add mark change', () => {
    const r = ok('one two three four', 'one **two three** four');
    expect(r.changes.length).toBe(0);
    expect(r.markChanges.length).toBe(1);
    expect(r.markChanges[0]?.kind).toBe('add');
    expect(r.markChanges[0]?.markName).toBe('strong');
  });

  test('link removed → a remove mark change on the link mark', () => {
    const r = ok('see [the docs](https://example.com) now', 'see the docs now');
    expect(r.markChanges.some((m) => m.kind === 'remove' && m.markName === 'link')).toBe(true);
  });

  test('mark on newly inserted text is not double-reported (dropped)', () => {
    // The whole bold phrase is inserted — it must read as an insertion, not as a
    // separate "formatting added" mark change on the same range.
    const r = ok('start.', 'start. **fresh bold**');
    const { ins } = counts(r.changes);
    expect(ins).toBeGreaterThan(0);
    expect(r.markChanges.length).toBe(0);
  });

  // Block-level alignment: heavy rewrite/reorder must produce a few whole-block
  // changes, not word-salad, and must leave unchanged sibling blocks alone.
  test('editing one list item leaves the other items untouched', () => {
    const before = `- [[proposals/0001|Proposal 0001]] vision.
- [[specs/x/spec|Spec A]] tasks.
- Old third item.`;
    const after = `- [[proposals/0001|Proposal 0001]] vision.
- [[specs/x/spec|Spec A]] tasks.
- Reworded third item.`;
    const r = ok(before, after);
    // Exactly the third item: one whole-block delete + one whole-block insert.
    expect(r.changes.length).toBe(2);
    const touched = r.changes
      .map(
        (c) =>
          (c.toB > c.fromB ? r.afterDoc.textBetween(c.fromB, c.toB, ' ') : '') +
          (c.toA > c.fromA ? r.beforeDoc.textBetween(c.fromA, c.toA, ' ') : ''),
      )
      .join('');
    expect(touched).toContain('third item');
    expect(touched).not.toContain('Proposal');
    expect(touched).not.toContain('Spec');
  });

  test('rewrite + reorder of bullets stays block-level (no word-salad)', () => {
    const before = `- Agent Activity Panel (per-file diffs, per-file undo).
- Change summaries per write.`;
    const after = `- **Timeline tab** — a unified human+agent feed.
- Agent Activity Panel (separate, agent-scoped: per-file diffs, per-file undo).
- Change summaries per write, shown on Timeline rows.`;
    const r = ok(before, after);
    // Two removed bullets + three added bullets = 5 whole-block changes, not the
    // ~29 interleaved word ranges the whole-doc word diff produced.
    expect(r.changes.length).toBeLessThanOrEqual(6);
  });
});
