import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import { describe, expect, test } from 'vitest';
import {
  createReplaceAllFindMatchesTransaction,
  findNextActiveIndexAfterReplacement,
  findReplacePlugin,
  findReplacePluginKey,
  getFindReplaceState,
} from './tiptap-find-replace-extension';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
});

function stateForText(text: string): EditorState {
  return EditorState.create({
    doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])]),
    plugins: [findReplacePlugin()],
  });
}

function setQuery(state: EditorState, query: string): EditorState {
  return state.apply(
    state.tr.setMeta(findReplacePluginKey, {
      type: 'setQuery',
      query,
      options: { caseSensitive: false, wholeWord: false },
      activeIndex: 0,
    }),
  );
}

function setOptions(
  state: EditorState,
  options: { caseSensitive?: boolean; wholeWord?: boolean },
  activeIndex?: number,
): EditorState {
  return state.apply(
    state.tr.setMeta(findReplacePluginKey, {
      type: 'setOptions',
      options,
      activeIndex,
    }),
  );
}

function decorationAttrs(state: EditorState): Array<Record<string, string>> {
  const plugin = findReplacePluginKey.get(state);
  const decorations = plugin?.props.decorations?.(state) as DecorationSet | null | undefined;
  return (
    decorations?.find().map((decoration) => {
      return (decoration as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
    }) ?? []
  );
}

describe('findReplacePlugin', () => {
  test('creates decorations for all matches', () => {
    const state = setQuery(stateForText('alpha beta alpha'), 'alpha');
    expect(getFindReplaceState(state).matches).toEqual([
      { from: 1, to: 6, text: 'alpha' },
      { from: 12, to: 17, text: 'alpha' },
    ]);
    expect(decorationAttrs(state)).toEqual([
      { class: 'ok-find-match ok-find-match-active' },
      { class: 'ok-find-match' },
    ]);
  });

  test('active index changes the active decoration', () => {
    const initial = setQuery(stateForText('alpha beta alpha'), 'alpha');
    const state = initial.apply(
      initial.tr.setMeta(findReplacePluginKey, {
        type: 'setActiveIndex',
        activeIndex: 1,
      }),
    );
    expect(getFindReplaceState(state).activeIndex).toBe(1);
    expect(decorationAttrs(state)).toEqual([
      { class: 'ok-find-match' },
      { class: 'ok-find-match ok-find-match-active' },
    ]);
  });

  test('doc changes recompute matches and clamp active index', () => {
    const initial = setQuery(stateForText('alpha beta alpha'), 'alpha');
    const activeSecond = initial.apply(
      initial.tr.setMeta(findReplacePluginKey, {
        type: 'setActiveIndex',
        activeIndex: 1,
      }),
    );
    const replaced = activeSecond.apply(activeSecond.tr.insertText('omega', 12, 17));
    expect(getFindReplaceState(replaced).matches).toEqual([{ from: 1, to: 6, text: 'alpha' }]);
    expect(getFindReplaceState(replaced).activeIndex).toBe(0);
  });

  test('clear removes matches and decorations', () => {
    const initial = setQuery(stateForText('alpha beta alpha'), 'alpha');
    const cleared = initial.apply(initial.tr.setMeta(findReplacePluginKey, { type: 'clear' }));
    expect(getFindReplaceState(cleared).matches).toEqual([]);
    expect(decorationAttrs(cleared)).toEqual([]);
  });

  test('setOptions preserves the query and recomputes matches', () => {
    const initial = setQuery(stateForText('Alpha alpha'), 'alpha');
    expect(getFindReplaceState(initial).matches).toHaveLength(2);

    const state = setOptions(initial, { caseSensitive: true });
    expect(getFindReplaceState(state).query).toBe('alpha');
    expect(getFindReplaceState(state).options.caseSensitive).toBe(true);
    expect(getFindReplaceState(state).matches).toEqual([{ from: 7, to: 12, text: 'alpha' }]);
  });

  test('setOptions preserves the active index when it remains valid', () => {
    const initial = setQuery(stateForText('alpha alpha'), 'alpha');
    const activeSecond = initial.apply(
      initial.tr.setMeta(findReplacePluginKey, {
        type: 'setActiveIndex',
        activeIndex: 1,
      }),
    );

    const state = setOptions(activeSecond, { wholeWord: true });
    expect(getFindReplaceState(state).activeIndex).toBe(1);
  });
});

describe('findNextActiveIndexAfterReplacement', () => {
  test('skips matches inside the replacement text and advances to the next original match', () => {
    expect(
      findNextActiveIndexAfterReplacement(
        [
          { from: 1, to: 4, text: 'foo' },
          { from: 6, to: 9, text: 'foo' },
        ],
        1,
        'fooX'.length,
      ),
    ).toBe(1);
  });

  test('wraps to the first match when replacement was after the final match', () => {
    expect(
      findNextActiveIndexAfterReplacement(
        [
          { from: 1, to: 4, text: 'foo' },
          { from: 10, to: 13, text: 'foo' },
        ],
        10,
        'bar'.length,
      ),
    ).toBe(0);
  });
});

describe('createReplaceAllFindMatchesTransaction', () => {
  test('replaces every match in one transaction and resets active index', () => {
    const initial = setQuery(stateForText('foo one foo two'), 'foo');
    const activeSecond = initial.apply(
      initial.tr.setMeta(findReplacePluginKey, {
        type: 'setActiveIndex',
        activeIndex: 1,
      }),
    );
    const tr = createReplaceAllFindMatchesTransaction(
      activeSecond,
      getFindReplaceState(activeSecond),
      'marker',
    );
    expect(tr).not.toBeNull();
    if (!tr) {
      throw new Error('Expected replace-all transaction to be created');
    }

    const state = activeSecond.apply(tr);
    expect(state.doc.textContent).toBe('marker one marker two');
    expect(getFindReplaceState(state).activeIndex).toBe(0);
    expect(getFindReplaceState(state).matches).toEqual([]);
  });
});
