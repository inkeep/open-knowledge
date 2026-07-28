import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, test } from 'vitest';
import { createNestedCMExtensions } from './nested-cm-extensions';

function hasLineWrapping(state: EditorState): boolean {
  return state.facet(EditorView.contentAttributes).some((attrs) => {
    return attrs.class === 'cm-lineWrapping';
  });
}

function createState(options: { wordWrap?: boolean; compartment?: Compartment } = {}) {
  return EditorState.create({
    extensions: createNestedCMExtensions({
      themeCompartment: new Compartment(),
      resolvedTheme: 'light',
      wordWrapCompartment: options.compartment,
      wordWrap: options.wordWrap,
    }),
  });
}

describe('createNestedCMExtensions word-wrap option', () => {
  test('defaults word wrapping on for existing CodeMirror callers', () => {
    expect(hasLineWrapping(createState())).toBe(true);
  });

  test('honors wordWrap=false at mount', () => {
    expect(hasLineWrapping(createState({ wordWrap: false }))).toBe(false);
  });

  test('uses the caller compartment for runtime reconfiguration', () => {
    const compartment = new Compartment();
    const state = createState({ wordWrap: true, compartment });
    expect(hasLineWrapping(state)).toBe(true);

    const nextState = state.update({ effects: compartment.reconfigure([]) }).state;
    expect(hasLineWrapping(nextState)).toBe(false);
  });
});
