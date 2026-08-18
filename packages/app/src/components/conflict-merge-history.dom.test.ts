/**
 * Behavioral tests for `mergeAcceptHistory`.
 *
 * Accepting a hunk in `@codemirror/merge` is an effect-only transaction, so
 * CodeMirror's history ignores it unless the effect opts in via
 * `invertedEffects`. These tests pin both halves: that accept becomes undoable,
 * and that a mixed reject-then-accept sequence undoes newest-first instead of
 * skipping back to the older reject.
 *
 * The first test is a control that mounts WITHOUT the extension — it documents
 * the underlying library behavior and fails loudly if a future upgrade makes
 * this extension redundant.
 */

import { history, undo } from '@codemirror/commands';
import {
  acceptChunk,
  getChunks,
  getOriginalDoc,
  rejectChunk,
  unifiedMergeView,
} from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test } from 'vitest';
import { mergeAcceptHistory } from './conflict-merge-history';

const ORIGINAL = 'alpha\nbravo\ncharlie\ndelta\n';
const CURRENT = 'alpha\nBRAVO\ncharlie\nDELTA\n';

const views: EditorView[] = [];

function mount(extra: Extension[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: CURRENT,
      extensions: [
        history(),
        ...extra,
        unifiedMergeView({ original: ORIGINAL, mergeControls: false }),
      ],
    }),
    parent,
  });
  views.push(view);
  return view;
}

function chunkCount(view: EditorView): number {
  return getChunks(view.state)?.chunks.length ?? -1;
}

function firstChunkPos(view: EditorView): number {
  const chunks = getChunks(view.state)?.chunks ?? [];
  if (chunks.length === 0) throw new Error('expected at least one chunk');
  return chunks[0].fromB;
}

function lastChunkPos(view: EditorView): number {
  const chunks = getChunks(view.state)?.chunks ?? [];
  if (chunks.length === 0) throw new Error('expected at least one chunk');
  return chunks[chunks.length - 1].fromB;
}

afterEach(() => {
  while (views.length > 0) views.pop()?.destroy();
  document.body.innerHTML = '';
});

describe('mergeAcceptHistory', () => {
  test('control: without the extension, undo after accept is a no-op', () => {
    const view = mount();
    expect(chunkCount(view)).toBe(2);

    acceptChunk(view, firstChunkPos(view));
    expect(chunkCount(view)).toBe(1);

    undo(view);

    // The accept is invisible to history, so the hunk does not come back.
    expect(chunkCount(view)).toBe(1);
  });

  test('undo after accept restores the hunk to unresolved', () => {
    const view = mount([mergeAcceptHistory()]);
    expect(chunkCount(view)).toBe(2);

    acceptChunk(view, firstChunkPos(view));
    expect(chunkCount(view)).toBe(1);

    undo(view);

    expect(chunkCount(view)).toBe(2);
    expect(getOriginalDoc(view.state).toString()).toBe(ORIGINAL);
  });

  test('undo after reject still works', () => {
    const view = mount([mergeAcceptHistory()]);

    rejectChunk(view, firstChunkPos(view));
    expect(view.state.doc.toString()).toContain('bravo');

    undo(view);

    expect(view.state.doc.toString()).toContain('BRAVO');
    expect(chunkCount(view)).toBe(2);
  });

  test('accepting every hunk then undoing brings the last one back', () => {
    const view = mount([mergeAcceptHistory()]);

    acceptChunk(view, lastChunkPos(view));
    acceptChunk(view, firstChunkPos(view));
    expect(chunkCount(view)).toBe(0);

    undo(view);

    // Exactly one: the two accepts must be two undo steps, not collapsed into
    // one by history's group-adjacent-edits window.
    expect(chunkCount(view)).toBe(1);
    // And it must be the LAST accept that came back, not an arbitrary one:
    // the second accept (bravo) is undone while the first (delta) still holds.
    const original = getOriginalDoc(view.state).toString();
    expect(original).toContain('bravo');
    expect(original).toContain('DELTA');
  });

  test('mixed reject-then-accept undoes the accept first, not the older reject', () => {
    const view = mount([mergeAcceptHistory()]);

    rejectChunk(view, firstChunkPos(view));
    expect(view.state.doc.toString()).toContain('bravo');

    acceptChunk(view, lastChunkPos(view));
    expect(getOriginalDoc(view.state).toString()).toContain('DELTA');

    undo(view);

    // The accept is undone: the original side is restored...
    expect(getOriginalDoc(view.state).toString()).toBe(ORIGINAL);
    // ...and the older reject is still applied, i.e. undo did not skip past it.
    expect(view.state.doc.toString()).toContain('bravo');
  });
});
