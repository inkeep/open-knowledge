import { describe, expect, test } from 'bun:test';
import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { computeArrowIntoTargetAtBoundary } from './raw-mdx-fallback';

const schema = getSchema(sharedExtensions);

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

describe('computeArrowIntoTargetAtBoundary', () => {
  describe('paragraph → fallback (forward: down/right)', () => {
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
    const doc = docOf(fallback('before'), p('mid'), fallback('after'));

    test('cursor at para end + dir=down → selects "after" fallback', () => {
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
    const doc = docOf(p('hello'), fallback('source'));

    test('cursor mid-paragraph + dir=down → still returns fallback target', () => {
      const state = stateWithCursor(doc, 3);
      const sel = computeArrowIntoTargetAtBoundary(state, 'down');
      expect(sel).not.toBeNull();
      expect(sel?.$head.parent.type.name).toBe('rawMdxFallback');
    });
  });
});
