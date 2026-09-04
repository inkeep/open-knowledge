import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { sourceLineDirection } from './source-line-direction';

describe('sourceLineDirection', () => {
  it('makes CodeMirror resolve direction per line rather than per editor', () => {
    const state = EditorState.create({ extensions: [sourceLineDirection] });

    expect(state.facet(EditorView.perLineTextDirection)).toBe(true);
  });
});
