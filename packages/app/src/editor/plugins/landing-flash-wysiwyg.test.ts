// @vitest-environment jsdom
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FLASH_DURATION_MS } from './flash-shared';
import { OK_LANDING_FLASH_CLASS } from './landing-flash-shared';
import {
  createLandingFlashPlugin,
  flashWysiwygLanding,
  landingFlashKey,
} from './landing-flash-wysiwyg';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
});

const para = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : []);
const doc = (...texts: string[]) => schema.node('doc', null, texts.map(para));

function makeState() {
  return EditorState.create({
    schema,
    doc: doc('alpha', 'omega'),
    plugins: [createLandingFlashPlugin()],
  });
}

/**
 * A minimal EditorView surface backed by a real EditorState, so the real plugin
 * reducer runs on every dispatch. The flash trigger only reaches `state` and
 * `dispatch`, and the removal timer keys off the view object.
 */
function drivenView() {
  let state = makeState();
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: ReturnType<EditorState['tr']['setMeta']>) {
      state = state.apply(tr);
    },
  };
  return {
    view: view as unknown as EditorView,
    getState: () => state,
    setSelection(pos: number) {
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    },
  };
}

const flashes = (state: EditorState) => landingFlashKey.getState(state)?.find() ?? [];

afterEach(() => {
  vi.useRealTimers();
});

describe('landing flash — wysiwyg plugin reducer', () => {
  test('add meta decorates the range', () => {
    let state = makeState();
    state = state.apply(state.tr.setMeta(landingFlashKey, { add: { from: 1, to: 6 } }));
    expect(flashes(state)).toHaveLength(1);
    expect(flashes(state)[0]?.from).toBe(1);
  });

  test('clear meta removes the decoration', () => {
    let state = makeState();
    state = state.apply(state.tr.setMeta(landingFlashKey, { add: { from: 1, to: 6 } }));
    state = state.apply(state.tr.setMeta(landingFlashKey, { clear: true }));
    expect(flashes(state)).toHaveLength(0);
  });

  test('a superseding add replaces the prior range', () => {
    let state = makeState();
    state = state.apply(state.tr.setMeta(landingFlashKey, { add: { from: 1, to: 6 } }));
    state = state.apply(state.tr.setMeta(landingFlashKey, { add: { from: 8, to: 13 } }));
    const decos = flashes(state);
    expect(decos).toHaveLength(1);
    expect(decos[0]?.from).toBe(8);
  });

  test('decorations map through an unrelated document change', () => {
    let state = makeState();
    state = state.apply(state.tr.setMeta(landingFlashKey, { add: { from: 8, to: 13 } }));
    state = state.apply(state.tr.insertText('shift', 2));
    const decos = flashes(state);
    expect(decos).toHaveLength(1);
    expect(decos[0]?.from).toBe(13);
  });
});

describe('landing flash — wysiwyg trigger', () => {
  test('suppresses the flash at a clamped grade', () => {
    const { view, getState } = drivenView();
    flashWysiwygLanding(view, 1, 6, 'clamped');
    expect(flashes(getState())).toHaveLength(0);
  });

  test('suppresses the flash at an unverified ordinal grade', () => {
    const { view, getState } = drivenView();
    flashWysiwygLanding(view, 1, 6, 'ordinal');
    expect(flashes(getState())).toHaveLength(0);
  });

  test('flashes then clears after the shared duration', () => {
    vi.useFakeTimers();
    const { view, getState } = drivenView();
    flashWysiwygLanding(view, 1, 6, 'exact');
    expect(flashes(getState())).toHaveLength(1);
    vi.advanceTimersByTime(FLASH_DURATION_MS);
    expect(flashes(getState())).toHaveLength(0);
  });

  test('never changes the selection', () => {
    const { view, getState, setSelection } = drivenView();
    setSelection(2);
    const before = getState().selection;
    flashWysiwygLanding(view, 8, 13, 'exact');
    expect(getState().selection.eq(before)).toBe(true);
  });

  test('clamps an out-of-range target to the document', () => {
    const { view, getState } = drivenView();
    flashWysiwygLanding(view, 1, 9999, 'exact');
    const decos = flashes(getState());
    expect(decos[0]?.to).toBe(getState().doc.content.size);
  });
});

describe('landing flash — wysiwyg rendering', () => {
  /** Mount a real view so the decoration's rendered attributes are observable. */
  function mountedView(): EditorView {
    const host = document.createElement('div');
    document.body.appendChild(host);
    return new EditorView(host, { state: makeState() });
  }

  test('paints the shared landing-flash class onto the landed range in the DOM', () => {
    // Decoration ranges alone do not prove the highlight is visible: the class
    // is the contract with the stylesheet, so it is asserted on a real mounted
    // view rather than on the plugin's state.
    const view = mountedView();
    try {
      flashWysiwygLanding(view, 1, 6, 'exact');
      expect(view.dom.querySelector(`.${OK_LANDING_FLASH_CLASS}`)?.textContent).toBe('alpha');
    } finally {
      view.destroy();
    }
  });

  test('removes the flashed class from the DOM after the shared duration', () => {
    vi.useFakeTimers();
    const view = mountedView();
    try {
      flashWysiwygLanding(view, 1, 6, 'exact');
      expect(view.dom.querySelector(`.${OK_LANDING_FLASH_CLASS}`)).not.toBeNull();
      vi.advanceTimersByTime(FLASH_DURATION_MS);
      expect(view.dom.querySelector(`.${OK_LANDING_FLASH_CLASS}`)).toBeNull();
    } finally {
      view.destroy();
    }
  });
});
