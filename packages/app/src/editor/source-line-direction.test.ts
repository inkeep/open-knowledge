import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { sourceLineDirection } from './source-line-direction';

describe('sourceLineDirection', () => {
  it('makes CodeMirror resolve direction per line rather than per editor', () => {
    // The rendered half — a `dir="auto"` on each line — is asserted in a real
    // browser by `tests/stress/user-text-direction.e2e.ts`. This is the half
    // that has no rendered evidence: with the facet off, CodeMirror keeps
    // placing the caret by the editor's direction while the glyphs follow the
    // line's, and nothing about the painted result would show it.
    const state = EditorState.create({ extensions: [sourceLineDirection] });

    expect(state.facet(EditorView.perLineTextDirection)).toBe(true);
  });
});
