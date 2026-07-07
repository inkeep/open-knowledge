/**
 * Unit tests for the arrow-into-rawMdxFallback decision helper.
 *
 * Locks the pure-state portion of the "arrow key from an adjacent paragraph
 * lands inside a rawMdxFallback" contract. The view-coupled
 * `view.endOfTextblock(dir)` check is the caller's responsibility — we test
 * only the selection-resolution + node-type gate.
 *
 * Scenarios covered:
 *   - Cursor at paragraph END with rawMdxFallback following → returns selection
 *     targeting the fallback (down/right).
 *   - Cursor at paragraph START with rawMdxFallback preceding → returns
 *     selection targeting the fallback (up/left).
 *   - Cursor with no adjacent rawMdxFallback → returns null.
 *   - Non-empty selection → returns null regardless of position.
 *   - Both sides (before AND after) wrapped in rawMdxFallback → returns the
 *     side matching `dir`.
 */

import { describe, expect, test } from 'bun:test';
import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { computeArrowIntoTargetAtBoundary } from './raw-mdx-fallback';

const schema = getSchema(sharedExtensions);

// ── Fixture builders ─────────────────────────────────────────────────────

function p(text: string): PMNode {
  return schema.node('paragraph', null, text ? [schema.text(text)] : []);
}

function fallback(source: string): PMNode {
  return schema.node(
    'rawMdxFallback',
    { reason: 'test fixture' },
    source ? [schema.text(source)] : [],
  );
}

function docOf(...children: PMNode[]): PMNode {
  return schema.node('doc', null, children);
}

function stateWithCursor(doc: PMNode, pos: number): EditorState {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos),
  });
}

function stateWithRange(doc: PMNode, anchor: number, head: number): EditorState {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, anchor, head),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('computeArrowIntoTargetAtBoundary', () => {
  describe('paragraph → fallback (forward: down/right)', () => {
    // doc structure: <p>hello</p><rawMdxFallback>source</rawMdxFallback>
    // "hello" occupies positions 1-6 (para open at 0, text at 1..5, para close at 6)
    // fallback starts at 7, its text at 8
    const doc = docOf(p('hello'), fallback('source'));

    test('cursor at paragraph end + dir=down → selection targets fallback', () => {
      const state = stateWithCursor(doc, 6);
      const sel = computeArrowIntoTargetAtBoundary(state, 'down');
      expect(sel).not.toBeNull();
      expect(sel?.$head.parent.type.name).toBe('rawMdxFallback');
    });

    test('cursor at paragraph end + dir=right → selection targets fallback', () => {
      const state = stateWithCursor(doc, 6);
      const sel = computeArrowIntoTargetAtBoundary(state, 'right');
      expect(sel).not.toBeNull();
      expect(sel?.$head.parent.type.name).toBe('rawMdxFallback');
    });
  });

  describe('paragraph → fallback (backward: up/left)', () => {
    // doc structure: <rawMdxFallback>source</rawMdxFallback><p>hello</p>
    // fallback at 0, text at 1..6, close at 7; para open at 8, text at 9..13
    const doc = docOf(fallback('source'), p('hello'));

    test('cursor at paragraph start + dir=up → selection targets preceding fallback', () => {
      const state = stateWithCursor(doc, 9);
      const sel = computeArrowIntoTargetAtBoundary(state, 'up');
      expect(sel).not.toBeNull();
      expect(sel?.$head.parent.type.name).toBe('rawMdxFallback');
    });

    test('cursor at paragraph start + dir=left → selection targets preceding fallback', () => {
      const state = stateWithCursor(doc, 9);
      const sel = computeArrowIntoTargetAtBoundary(state, 'left');
      expect(sel).not.toBeNull();
      expect(sel?.$head.parent.type.name).toBe('rawMdxFallback');
    });
  });

  describe('no adjacent fallback → returns null', () => {
    // doc structure: <p>hello</p><p>world</p>
    const doc = docOf(p('hello'), p('world'));

    test('cursor at end of first paragraph + dir=down → null (next is paragraph)', () => {
      const state = stateWithCursor(doc, 6);
      const sel = computeArrowIntoTargetAtBoundary(state, 'down');
      expect(sel).toBeNull();
    });

    test('cursor at start of second paragraph + dir=up → null (prev is paragraph)', () => {
      const state = stateWithCursor(doc, 9);
      const sel = computeArrowIntoTargetAtBoundary(state, 'up');
      expect(sel).toBeNull();
    });
  });

  describe('non-empty selection → always returns null', () => {
    const doc = docOf(p('hello'), fallback('source'));

    test('range selection (anchor != head) at end of paragraph → null', () => {
      const state = stateWithRange(doc, 4, 6);
      const sel = computeArrowIntoTargetAtBoundary(state, 'down');
      expect(sel).toBeNull();
    });

    test('range selection at start of paragraph → null', () => {
      const doc2 = docOf(fallback('source'), p('hello'));
      const state = stateWithRange(doc2, 9, 11);
      const sel = computeArrowIntoTargetAtBoundary(state, 'up');
      expect(sel).toBeNull();
    });
  });

  describe('fallback on both sides → direction selects the correct one', () => {
    // doc structure: <rawMdxFallback>before</rawMdxFallback><p>mid</p><rawMdxFallback>after</rawMdxFallback>
    // before fallback: 0..7, para at 8..12, after fallback: 13..
    const doc = docOf(fallback('before'), p('mid'), fallback('after'));

    test('cursor at para end + dir=down → selects "after" fallback', () => {
      // para content range: 9..12. End of text at 12.
      const state = stateWithCursor(doc, 12);
      const sel = computeArrowIntoTargetAtBoundary(state, 'down');
      expect(sel).not.toBeNull();
      expect(sel?.$head.parent.textContent).toBe('after');
    });

    test('cursor at para start + dir=up → selects "before" fallback', () => {
      const state = stateWithCursor(doc, 9);
      const sel = computeArrowIntoTargetAtBoundary(state, 'up');
      expect(sel).not.toBeNull();
      expect(sel?.$head.parent.textContent).toBe('before');
    });
  });

  describe('edge: cursor mid-paragraph', () => {
    // Caller gates on view.endOfTextblock(dir); this helper doesn't double-check.
    // But $head.after()/.before() still resolves — we're testing the node-type gate.
    const doc = docOf(p('hello'), fallback('source'));

    test('cursor mid-paragraph + dir=down → still returns fallback target', () => {
      // Not a view-boundary scenario in production, but the helper is pure —
      // it returns what Selection.near lands on, regardless of DOM layout.
      // In production the view.endOfTextblock guard prevents this being hit.
      const state = stateWithCursor(doc, 3);
      const sel = computeArrowIntoTargetAtBoundary(state, 'down');
      expect(sel).not.toBeNull();
      expect(sel?.$head.parent.type.name).toBe('rawMdxFallback');
    });
  });
});
