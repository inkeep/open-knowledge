import { afterEach, describe, expect, test, vi } from 'vitest';
import { repairFocusAndReadProbe } from '../stress/_helpers/editor-state';

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
    { outcome: 'covers-document', from: 0, to: 12, length: 12 },
    { outcome: 'covers-document', from: 0, to: 0, length: 0 },
    { outcome: 'partial', from: 2, to: 5, length: 12 },
    { outcome: 'partial', from: 0, to: 5, length: 12 },
    { outcome: 'partial', from: 3, to: 12, length: 12 },
    { outcome: 'empty', from: 4, to: 4, length: 12 },
    { outcome: 'unreadable', from: 0, to: undefined, length: 12 },
  ])('CodeMirror $from-$to over a $length-character document reads $outcome', ({
    outcome,
    from,
    to,
    length,
  }) => {
    mountCodeMirror({ from, to }, length);
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR).viewSelection).toBe(outcome);
  });

  test('CodeMirror is reached through the cmView handle when cmTile is absent', () => {
    mountCodeMirror({ from: 0, to: 9 }, 9, 'cmView');
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR).viewSelection).toBe('covers-document');
  });

  test('a mounted source editor carrying neither handle reads unreadable', () => {
    mount(SOURCE_MARKUP, SOURCE_CONTENT_SELECTOR);
    expect(repairFocusAndReadProbe(SOURCE_CONTENT_SELECTOR).viewSelection).toBe('unreadable');
  });

  test.each([
    { outcome: 'covers-document', from: 0, to: 14, size: 14 },
    { outcome: 'covers-document', from: 0, to: 2, size: 2 },
    { outcome: 'partial', from: 1, to: 6, size: 14 },
    { outcome: 'partial', from: 4, to: 14, size: 14 },
    { outcome: 'empty', from: 3, to: 3, size: 14 },
    { outcome: 'unreadable', from: 0, to: undefined, size: 14 },
  ])('ProseMirror $from-$to over a size-$size document reads $outcome', ({
    outcome,
    from,
    to,
    size,
  }) => {
    mountProseMirror({ from, to }, size);
    expect(repairFocusAndReadProbe(WYSIWYG_SELECTOR).viewSelection).toBe(outcome);
  });

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
