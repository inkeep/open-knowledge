import { describe, expect, test } from 'vitest';
import {
  computeEditorHiddenLayout,
  editorHiddenLayoutLanded,
  isEditorHiddenLayoutSettled,
} from './editor-area-hidden-editor';

const EDITOR = 'editor-column';
const TERMINAL = 'terminal-column';
const CHAT = 'agents-column';

describe('the outer row with the editor hidden', () => {
  test('a right terminal and chat share the row in proportion to their widths', () => {
    const next = computeEditorHiddenLayout({
      currentLayout: { [EDITOR]: 50, [TERMINAL]: 20, [CHAT]: 30 },
      editorColumnId: EDITOR,
      visibleColumnPx: { [TERMINAL]: 300, [CHAT]: 450 },
    });
    expect(next[EDITOR]).toBe(0);
    expect(next[TERMINAL]).toBeCloseTo(40);
    expect(next[CHAT]).toBeCloseTo(60);
  });

  test('one remaining column fills the row and a hidden one gets nothing', () => {
    const next = computeEditorHiddenLayout({
      currentLayout: { [EDITOR]: 70, [TERMINAL]: 0, [CHAT]: 30 },
      editorColumnId: EDITOR,
      visibleColumnPx: { [TERMINAL]: 0, [CHAT]: 450 },
    });
    expect(next).toEqual({ [EDITOR]: 0, [TERMINAL]: 0, [CHAT]: 100 });
  });

  test('with no right column the editor column keeps the whole row', () => {
    const next = computeEditorHiddenLayout({
      currentLayout: { [EDITOR]: 80, [TERMINAL]: 0, [CHAT]: 20 },
      editorColumnId: EDITOR,
      visibleColumnPx: { [TERMINAL]: 0, [CHAT]: 0 },
    });
    expect(next).toEqual({ [EDITOR]: 100, [TERMINAL]: 0, [CHAT]: 0 });
  });

  test('the written layout keeps the group’s own key order', () => {
    const next = computeEditorHiddenLayout({
      currentLayout: { [EDITOR]: 50, [TERMINAL]: 20, [CHAT]: 30 },
      editorColumnId: EDITOR,
      visibleColumnPx: { [CHAT]: 450, [TERMINAL]: 300 },
    });
    expect(Object.keys(next)).toEqual([EDITOR, TERMINAL, CHAT]);
  });

  test('an editor column that still holds a pane takes its share like any other column', () => {
    const next = computeEditorHiddenLayout({
      currentLayout: { [EDITOR]: 0, [TERMINAL]: 0, [CHAT]: 100 },
      editorColumnId: EDITOR,
      visibleColumnPx: { [EDITOR]: 900, [CHAT]: 300 },
    });
    expect(next).toEqual({ [EDITOR]: 75, [TERMINAL]: 0, [CHAT]: 25 });
  });

  test('a column the group does not hold is ignored', () => {
    const next = computeEditorHiddenLayout({
      currentLayout: { [EDITOR]: 60, [CHAT]: 40 },
      editorColumnId: EDITOR,
      visibleColumnPx: { [TERMINAL]: 300, [CHAT]: 450 },
    });
    expect(next).toEqual({ [EDITOR]: 0, [CHAT]: 100 });
  });
});

describe('a hidden-editor row that is already settled is left alone', () => {
  test('a divider dragged while hidden keeps its shares', () => {
    expect(
      isEditorHiddenLayoutSettled({
        currentLayout: { [EDITOR]: 0, [TERMINAL]: 70, [CHAT]: 30 },
        editorColumnId: EDITOR,
        visibleColumnPx: { [TERMINAL]: 300, [CHAT]: 450 },
      }),
    ).toBe(true);
  });

  test('an editor column still holding width is not settled', () => {
    expect(
      isEditorHiddenLayoutSettled({
        currentLayout: { [EDITOR]: 5, [TERMINAL]: 65, [CHAT]: 30 },
        editorColumnId: EDITOR,
        visibleColumnPx: { [TERMINAL]: 300, [CHAT]: 450 },
      }),
    ).toBe(false);
  });

  test('a column that closed while hidden but still holds width is not settled', () => {
    expect(
      isEditorHiddenLayoutSettled({
        currentLayout: { [EDITOR]: 0, [TERMINAL]: 70, [CHAT]: 30 },
        editorColumnId: EDITOR,
        visibleColumnPx: { [TERMINAL]: 300, [CHAT]: 0 },
      }),
    ).toBe(false);
  });

  test('a column that opened while hidden but has no width yet is not settled', () => {
    expect(
      isEditorHiddenLayoutSettled({
        currentLayout: { [EDITOR]: 0, [TERMINAL]: 100, [CHAT]: 0 },
        editorColumnId: EDITOR,
        visibleColumnPx: { [TERMINAL]: 300, [CHAT]: 450 },
      }),
    ).toBe(false);
  });

  test('an editor column that still holds a pane is settled only while it has width', () => {
    const params = {
      editorColumnId: EDITOR,
      visibleColumnPx: { [EDITOR]: 900, [CHAT]: 300 },
    };
    expect(
      isEditorHiddenLayoutSettled({
        ...params,
        currentLayout: { [EDITOR]: 65, [TERMINAL]: 0, [CHAT]: 35 },
      }),
    ).toBe(true);
    expect(
      isEditorHiddenLayoutSettled({
        ...params,
        currentLayout: { [EDITOR]: 0, [TERMINAL]: 0, [CHAT]: 100 },
      }),
    ).toBe(false);
  });

  test('no right column is settled only when the editor column holds the row', () => {
    const params = {
      editorColumnId: EDITOR,
      visibleColumnPx: { [TERMINAL]: 0, [CHAT]: 0 },
    };
    expect(
      isEditorHiddenLayoutSettled({
        ...params,
        currentLayout: { [EDITOR]: 100, [TERMINAL]: 0, [CHAT]: 0 },
      }),
    ).toBe(true);
    expect(
      isEditorHiddenLayoutSettled({
        ...params,
        currentLayout: { [EDITOR]: 80, [TERMINAL]: 0, [CHAT]: 20 },
      }),
    ).toBe(false);
  });
});

describe('a written hidden-editor layout is checked against what the group read back', () => {
  test('a clamped write does not count as landed', () => {
    expect(
      editorHiddenLayoutLanded({ [EDITOR]: 0, [CHAT]: 100 }, { [EDITOR]: 5, [CHAT]: 95 }),
    ).toBe(false);
  });

  test('a write within rounding counts as landed', () => {
    expect(
      editorHiddenLayoutLanded(
        { [EDITOR]: 0, [TERMINAL]: 40, [CHAT]: 60 },
        { [EDITOR]: 0, [TERMINAL]: 40.2, [CHAT]: 59.8 },
      ),
    ).toBe(true);
  });
});
