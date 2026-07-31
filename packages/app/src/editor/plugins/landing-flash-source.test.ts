// @vitest-environment jsdom
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { type DecorationSet, EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FLASH_DURATION_MS } from './flash-shared';
import { OK_LANDING_FLASH_CLASS } from './landing-flash-shared';
import { flashSourceLanding, landingFlashField, landingFlashSource } from './landing-flash-source';

/**
 * A minimal EditorView surface backed by a real EditorState, so the real field
 * reducer runs on every dispatch. The flash trigger only reaches `state` and
 * `dispatch`, and the removal timer keys off the view object (a valid WeakMap
 * key), so this exercises the production path without a live DOM view.
 */
function drivenView(doc: string, selection?: { anchor: number; head?: number }) {
  let state = EditorState.create({
    doc,
    selection: selection
      ? { anchor: selection.anchor, head: selection.head ?? selection.anchor }
      : undefined,
    extensions: [landingFlashField],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  };
  return { view: view as unknown as EditorView, getState: () => state };
}

function ranges(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({ from: cursor.from, to: cursor.to });
    cursor.next();
  }
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('landing flash — source', () => {
  test('flashes the landed range at a precise grade', () => {
    const { view, getState } = drivenView('alpha\nbeta\ngamma');
    flashSourceLanding(view, 0, 5, 'exact');
    expect(ranges(getState().field(landingFlashField))).toEqual([{ from: 0, to: 5 }]);
  });

  test('suppresses the flash at a clamped grade', () => {
    const { view, getState } = drivenView('alpha\nbeta\ngamma');
    flashSourceLanding(view, 0, 5, 'clamped');
    expect(getState().field(landingFlashField).size).toBe(0);
  });

  test('suppresses the flash at an unverified ordinal grade', () => {
    const { view, getState } = drivenView('alpha\nbeta\ngamma');
    flashSourceLanding(view, 0, 5, 'ordinal');
    expect(getState().field(landingFlashField).size).toBe(0);
  });

  test('clears the flash after the shared duration', () => {
    vi.useFakeTimers();
    const { view, getState } = drivenView('alpha\nbeta\ngamma');
    flashSourceLanding(view, 0, 5, 'exact');
    expect(getState().field(landingFlashField).size).toBe(1);
    vi.advanceTimersByTime(FLASH_DURATION_MS);
    expect(getState().field(landingFlashField).size).toBe(0);
  });

  test('maps the flash through a later document change', () => {
    const { view, getState } = drivenView('alpha\nbeta\ngamma');
    flashSourceLanding(view, 6, 10, 'exact');
    view.dispatch({ changes: { from: 0, insert: 'XX' } });
    expect(ranges(getState().field(landingFlashField))).toEqual([{ from: 8, to: 12 }]);
  });

  test('never changes the selection', () => {
    const { view, getState } = drivenView('alpha\nbeta\ngamma', { anchor: 3 });
    const before = getState().selection.main;
    flashSourceLanding(view, 6, 10, 'exact');
    const after = getState().selection.main;
    expect(after.anchor).toBe(before.anchor);
    expect(after.head).toBe(before.head);
  });

  test('clamps an out-of-range target to the document', () => {
    const { view, getState } = drivenView('alpha\nbeta\ngamma');
    flashSourceLanding(view, 0, 99999, 'exact');
    const [range] = ranges(getState().field(landingFlashField));
    expect(range?.to).toBe(getState().doc.length);
  });

  test('a superseding landing replaces the prior flash', () => {
    const { view, getState } = drivenView('alpha\nbeta\ngamma');
    flashSourceLanding(view, 0, 5, 'exact');
    flashSourceLanding(view, 6, 10, 'exact');
    expect(ranges(getState().field(landingFlashField))).toEqual([{ from: 6, to: 10 }]);
  });

  test('landingFlashSource wires the field into a state', () => {
    const state = EditorState.create({ doc: 'x', extensions: [landingFlashSource()] });
    expect(state.field(landingFlashField).size).toBe(0);
  });

  test('paints the shared landing-flash class onto the landed range in the DOM', () => {
    // Decoration ranges alone do not prove the highlight is visible: the class
    // is the contract with the stylesheet, so it is asserted on a real mounted
    // view rather than on the field's state.
    const view = new EditorView({
      state: EditorState.create({ doc: 'alpha\nbeta\ngamma', extensions: [landingFlashSource()] }),
      parent: document.body,
    });
    try {
      flashSourceLanding(view, 0, 5, 'exact');
      expect(view.dom.querySelector(`.${OK_LANDING_FLASH_CLASS}`)?.textContent).toBe('alpha');
    } finally {
      view.destroy();
    }
  });

  test('removes the flashed class from the DOM after the shared duration', () => {
    vi.useFakeTimers();
    const view = new EditorView({
      state: EditorState.create({ doc: 'alpha\nbeta\ngamma', extensions: [landingFlashSource()] }),
      parent: document.body,
    });
    try {
      flashSourceLanding(view, 0, 5, 'exact');
      expect(view.dom.querySelector(`.${OK_LANDING_FLASH_CLASS}`)).not.toBeNull();
      vi.advanceTimersByTime(FLASH_DURATION_MS);
      expect(view.dom.querySelector(`.${OK_LANDING_FLASH_CLASS}`)).toBeNull();
    } finally {
      view.destroy();
    }
  });
});
