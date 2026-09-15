import { EditorState } from '@codemirror/state';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  abandonedPollRefusal,
  repairFocusAndReadProbe,
  selectAllAndWaitForSelection,
} from '../stress/_helpers/editor-state';

const SOURCE_CONTENT_SELECTOR = '.source-editor .cm-content';
const WYSIWYG_SELECTOR = '.ProseMirror:not(.composer-prosemirror)';
const SOURCE_MARKUP =
  '<div class="source-editor"><div class="cm-content" contenteditable="true"></div></div>';
const WYSIWYG_MARKUP = '<div class="ProseMirror" contenteditable="true"></div>';

type Reading = { from: number | undefined; to: number | undefined };

function mount(html: string, selector: string): HTMLElement {
  document.body.innerHTML = html;
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`mount: "${selector}" did not mount`);
  return el;
}

function mountCodeMirror(
  main: Reading,
  length: number,
  via: 'cmTile' | 'cmView' = 'cmTile',
): HTMLElement {
  const el = mount(SOURCE_MARKUP, SOURCE_CONTENT_SELECTOR);
  const view = { state: { doc: { length }, selection: { main } } };
  if (via === 'cmTile') Object.assign(el, { cmTile: { root: { view } } });
  else Object.assign(el, { cmView: { rootView: { view } } });
  return el;
}

function mountRealCodeMirror(
  doc: string,
  selection?: { anchor: number; head: number },
): { state: EditorState } {
  const el = mount(SOURCE_MARKUP, SOURCE_CONTENT_SELECTOR);
  const view = { state: EditorState.create({ doc, selection }) };
  Object.assign(el, { cmTile: { root: { view } } });
  return view;
}

function jsdomPage(onPress: (key: string) => void = () => {}, onRead: () => void = () => {}): Page {
  return {
    focus: async (selector: string) => {
      document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    },
    evaluate: async (fn: (arg: string) => unknown, arg: string) => {
      onRead();
      return fn(arg);
    },
    keyboard: { press: async (key: string) => onPress(key) },
  } as unknown as Page;
}

function selectAllStub(
  view: { state: EditorState },
  landsOnPress: number,
): { pressed: string[]; onPress: (key: string) => void } {
  const pressed: string[] = [];
  return {
    pressed,
    onPress: (key) => {
      pressed.push(key);
      if (key !== 'ControlOrMeta+a' || pressed.length < landsOnPress) return;
      view.state = view.state.update({
        selection: { anchor: 0, head: view.state.doc.length },
      }).state;
    },
  };
}

function mountProseMirror(selection: Reading, size: number): HTMLElement {
  const el = mount(WYSIWYG_MARKUP, WYSIWYG_SELECTOR);
  vi.stubGlobal('__activeEditor', {
    editorView: { dom: el, state: { selection, doc: { content: { size } } } },
  });
  return el;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('select-all probe view classification', () => {
  test.each([
    { outcome: 'covers-document', from: 0, to: 12, length: 12, docEnd: 12 },
    { outcome: 'empty', from: 0, to: 0, length: 0, docEnd: 0 },
    { outcome: 'partial', from: 2, to: 5, length: 12, docEnd: 12 },
    { outcome: 'partial', from: 0, to: 5, length: 12, docEnd: 12 },
    { outcome: 'partial', from: 3, to: 12, length: 12, docEnd: 12 },
    { outcome: 'empty', from: 4, to: 4, length: 12, docEnd: 12 },
    { outcome: 'unreadable', from: 0, to: undefined, length: 12, docEnd: null },
  ])(
    'CodeMirror $from-$to over a $length-character document reads $outcome with docEnd $docEnd',
    ({ outcome, from, to, length, docEnd }) => {
      mountCodeMirror({ from, to }, length);
      expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR)).toMatchObject({
        viewSelection: outcome,
        docEnd,
      });
    },
  );

  test('CodeMirror is reached through the cmView handle when cmTile is absent', () => {
    mountCodeMirror({ from: 0, to: 9 }, 9, 'cmView');
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR).viewSelection).toBe('covers-document');
  });

  test('a mounted source editor carrying neither handle reads unreadable', () => {
    mount(SOURCE_MARKUP, SOURCE_CONTENT_SELECTOR);
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR).viewSelection).toBe('unreadable');
  });

  test.each([
    { outcome: 'covers-document', from: 0, to: 14, size: 14, docEnd: 14 },
    { outcome: 'covers-document', from: 0, to: 2, size: 2, docEnd: 2 },
    { outcome: 'partial', from: 1, to: 6, size: 14, docEnd: 14 },
    { outcome: 'partial', from: 4, to: 14, size: 14, docEnd: 14 },
    { outcome: 'empty', from: 3, to: 3, size: 14, docEnd: 14 },
    { outcome: 'unreadable', from: 0, to: undefined, size: 14, docEnd: null },
  ])(
    'ProseMirror $from-$to over a size-$size document reads $outcome with docEnd $docEnd',
    ({ outcome, from, to, size, docEnd }) => {
      mountProseMirror({ from, to }, size);
      expect(repairFocusAndReadProbe(WYSIWYG_SELECTOR)).toMatchObject({
        viewSelection: outcome,
        docEnd,
      });
    },
  );

  test('a ProseMirror view whose dom is a different element falls through to the CodeMirror branch', () => {
    mountProseMirror({ from: 0, to: 14 }, 14);
    mountCodeMirror({ from: 3, to: 7 }, 12);
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR).viewSelection).toBe('partial');
  });

  test('a selector that matches no element reads unreadable', () => {
    document.body.innerHTML = '<div class="unrelated"></div>';
    const probe = repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR);
    expect(probe.viewSelection).toBe('unreadable');
    expect(probe.matches).toBe(0);
  });
});

describe('select-all barrier discrimination at zero document length', () => {
  test('a real CodeMirror EditorState separates an empty-document caret from a select-all', () => {
    mountRealCodeMirror('');
    const emptyDoc = repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR);
    expect(
      emptyDoc,
      'a real empty CodeMirror document reports from, to and length as 0, 0, 0 — the triple the hand-shaped fixtures above only stand in for',
    ).toMatchObject({ viewSelection: 'empty', docEnd: 0 });

    mountRealCodeMirror('hello world', { anchor: 0, head: 11 });
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR)).toMatchObject({
      viewSelection: 'covers-document',
      docEnd: 11,
    });
  });

  test('the select-all barrier refuses a zero-length source document instead of polling for a selection no keystroke can produce', async () => {
    mountRealCodeMirror('');
    await expect(
      selectAllAndWaitForSelection(jsdomPage(), SOURCE_CONTENT_SELECTOR, {
        focusMs: 800,
        selectionMs: 800,
      }),
    ).rejects.toThrow(/holds a zero-length document/);
  });

  test('the select-all barrier settles on the selection the select-all keystroke produced, not on one the fixture arrived with', async () => {
    const { pressed, onPress } = selectAllStub(
      mountRealCodeMirror('hello world', { anchor: 0, head: 0 }),
      1,
    );
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR)).toMatchObject({
      viewSelection: 'empty',
      docEnd: 11,
    });

    let reads = 0;
    await expect(
      selectAllAndWaitForSelection(
        jsdomPage(onPress, () => {
          reads += 1;
        }),
        SOURCE_CONTENT_SELECTOR,
        { focusMs: 800, selectionMs: 800 },
      ),
    ).resolves.toBeUndefined();

    expect(pressed).toEqual(['ControlOrMeta+a']);
    expect(
      reads,
      'a fixture whose select-all lands on the first press costs the barrier exactly two page reads: the probe the focus poll settles on and the probe taken after the keystroke. A third read means the barrier paid a cross-process round trip outside a poll iteration and threw the answer away',
    ).toBe(2);
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR)).toMatchObject({
      viewSelection: 'covers-document',
      docEnd: 11,
    });
  });

  test('the select-all barrier presses again when the first keystroke leaves the selection unchanged', async () => {
    const { pressed, onPress } = selectAllStub(
      mountRealCodeMirror('hello world', { anchor: 0, head: 0 }),
      2,
    );

    await expect(
      selectAllAndWaitForSelection(jsdomPage(onPress), SOURCE_CONTENT_SELECTOR, {
        focusMs: 800,
        selectionMs: 800,
      }),
    ).resolves.toBeUndefined();

    expect(pressed).toEqual(['ControlOrMeta+a', 'ControlOrMeta+a']);
  });

  test('a probe the barrier could not read is never reported as a zero-length document, even when the document is zero-length', async () => {
    mountCodeMirror({ from: 0, to: undefined }, 0);
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR)).toMatchObject({
      viewSelection: 'unreadable',
      docEnd: null,
    });

    const pressed: string[] = [];
    const failure = await selectAllAndWaitForSelection(
      jsdomPage((key) => {
        pressed.push(key);
      }),
      SOURCE_CONTENT_SELECTOR,
      { focusMs: 800, selectionMs: 300 },
    ).catch((error: unknown) => error);

    if (!(failure instanceof Error)) {
      throw new Error('the select-all barrier resolved on a probe it could not read');
    }
    expect(failure.message).not.toMatch(/zero-length document/);
    expect(pressed).toContain('ControlOrMeta+a');
  });
});

describe('select-all barrier refusal on an abandoned poll', () => {
  test('the abandoned-poll refusal covers every window in which the poll can resolve on a reading its matcher rejects', () => {
    mountRealCodeMirror('hello world', { anchor: 0, head: 11 });
    const probe = repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR);
    expect(probe).toMatchObject({ focusOwnedByEditor: true, viewSelection: 'covers-document' });

    expect
      .soft(
        abandonedPollRefusal(SOURCE_CONTENT_SELECTOR, 'focus', undefined),
        'a focus poll that resolved before any probe was read was abandoned',
      )
      .toEqual(expect.stringMatching(/stopped being the running test/));
    expect
      .soft(
        abandonedPollRefusal(SOURCE_CONTENT_SELECTOR, 'focus', {
          ...probe,
          focusOwnedByEditor: false,
        }),
        'a focus poll that resolved holding a probe its own matcher rejects was abandoned on a later iteration, and the shipped settled-is-undefined predicate read that as success',
      )
      .toEqual(expect.stringMatching(/stopped being the running test/));
    expect
      .soft(
        abandonedPollRefusal(SOURCE_CONTENT_SELECTOR, 'focus', {
          ...probe,
          focusOwnedByEditor: true,
        }),
        'the probe shape a passing focus poll settles on must never be refused',
      )
      .toBeNull();

    expect
      .soft(
        abandonedPollRefusal(SOURCE_CONTENT_SELECTOR, 'select-all', undefined),
        'a select-all poll that resolved before any probe was read was abandoned',
      )
      .toEqual(expect.stringMatching(/stopped being the running test/));
    expect
      .soft(
        abandonedPollRefusal(SOURCE_CONTENT_SELECTOR, 'select-all', {
          ...probe,
          viewSelection: 'partial',
        }),
        'a select-all poll that resolved on a partial selection was abandoned, and returning there means the barrier never observed a full-document selection',
      )
      .toEqual(expect.stringMatching(/stopped being the running test/));
    expect
      .soft(
        abandonedPollRefusal(SOURCE_CONTENT_SELECTOR, 'select-all', {
          ...probe,
          viewSelection: 'covers-document',
        }),
        'the probe shape a passing select-all poll settles on must never be refused',
      )
      .toBeNull();
  });
});

describe('select-all probe focus repair', () => {
  test('the probe takes focus for an editor that does not own it on entry', () => {
    mountCodeMirror({ from: 0, to: 12 }, 12);
    const probe = repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR);
    expect(probe.focusOwnedOnEntry).toBe(false);
    expect(probe.focusOwnedByEditor).toBe(true);
    expect(probe.activeElement).toBe('div.cm-content');
  });

  test('an editor that already owns focus is reported as owning it on entry', () => {
    const el = mountCodeMirror({ from: 0, to: 12 }, 12);
    el.focus({ preventScroll: true });
    const probe = repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR);
    expect(probe.focusOwnedOnEntry).toBe(true);
    expect(probe.focusOwnedByEditor).toBe(true);
  });

  test('focus stolen by another element is reported as not owned', () => {
    document.body.innerHTML = `${SOURCE_MARKUP}<input class="thief" />`;
    const thief = document.querySelector('.thief');
    const editor = document.querySelector(SOURCE_CONTENT_SELECTOR);
    if (!(thief instanceof HTMLElement) || !(editor instanceof HTMLElement)) {
      throw new Error('focus-thief fixture did not mount');
    }
    editor.addEventListener('focus', () => thief.focus());
    const probe = repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR);
    expect(probe.focusOwnedOnEntry).toBe(false);
    expect(probe.focusOwnedByEditor).toBe(false);
    expect(probe.activeElement).toBe('input.thief');
  });
});
