/**
 * Underline reaches the document on two live paths, and must survive both.
 *
 * `Mod-U` toggles a real PM `underline` mark, and a Word/LibreOffice paste
 * carries `<u>` elements in its `text/html` flavor. Neither path had a
 * representation on the way back out: the PM→mdast direction had no underline
 * mark handler, so a typed underline was dropped at the first serialize with
 * no error, and the paste dispatcher's generic-HTML branch inherited
 * `hast-util-to-mdast`'s `u: em` default, so pasted underline arrived as
 * italic. The first is silent loss, the second is silent substitution; both
 * are invisible to a byte-level round-trip test because the bytes on disk are
 * self-consistent either way.
 *
 * The rig is the production re-derivation rather than a bare `parse()`:
 * Observer A serializes the fragment into Y.Text, Observer B splits the
 * frontmatter region off and re-parses the body with `parseWithFallback`.
 * That composition is what a live document actually runs on every settle,
 * document reload and agent undo.
 *
 * The paste route drives the real dispatcher (`createHandlePaste`) through
 * `view.pasteHTML`, so branch selection is the production one — a test that
 * called `insertContent` would exercise TipTap's own `parseHTML` rules and
 * never reach the generic-HTML branch that a foreign app's payload lands on.
 *
 */

import { MarkdownManager, sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { cleanup } from '@testing-library/react';
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import { AllSelection, EditorState } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test } from 'vitest';
import { createHandlePaste } from '../../src/editor/clipboard/handle-paste';

const mdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});
const schema = getSchema(sharedExtensions);

const mounted: Array<{ editor: Editor; container: HTMLDivElement }> = [];
const views: EditorView[] = [];

afterEach(() => {
  for (const { editor, container } of mounted.splice(0)) {
    editor.destroy();
    container.remove();
  }
  for (const view of views.splice(0)) view.destroy();
  cleanup();
});

function mount(content?: JSONContent): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    ...(content ? { content } : {}),
    extensions: sharedExtensions,
    editable: true,
  });
  const entry = { editor, container };
  mounted.push(entry);
  return entry;
}

/** Observer A serialize into Observer B's frontmatter-stripped re-parse. */
function rederive(doc: JSONContent): { bytes: string; next: JSONContent } {
  const bytes = mdManager.serialize(doc);
  return { bytes, next: mdManager.parseWithFallback(stripFrontmatter(bytes).body) };
}

/** Every mark name carried by the text node whose content is `text`. */
function marksOn(doc: JSONContent, text: string): string[] {
  const found: string[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === 'text' && node.text === text) {
      for (const mark of node.marks ?? []) found.push(mark.type);
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return found;
}

/** Concatenated text of a document, with a space at every block boundary. */
function allText(doc: JSONContent): string {
  const parts: string[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === 'text') parts.push(node.text ?? '');
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return parts.join('');
}

/** Concatenated text of every node carrying `markName`. */
function textUnderMark(doc: JSONContent, markName: string): string {
  let out = '';
  const walk = (node: JSONContent): void => {
    if (node.type === 'text' && (node.marks ?? []).some((mark) => mark.type === markName)) {
      out += node.text ?? '';
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return out;
}

/**
 * Apply `Mod-U` over a typed run the way the keymap does: insert the prose,
 * select the range, dispatch the chord. `keyboardShortcut` reports that it
 * dispatched rather than that a handler consumed, so the mark itself is
 * asserted before anything downstream is measured.
 */
function typeUnderlined(editor: Editor, before: string, underlined: string): void {
  editor.commands.insertContent(before);
  const start = editor.state.selection.from;
  editor.commands.insertContent(underlined);
  const end = editor.state.selection.from;
  editor.commands.setTextSelection({ from: start, to: end });
  editor.commands.keyboardShortcut('Mod-u');
  editor.commands.setTextSelection(end);
}

/**
 * A DataTransfer/ClipboardEvent stand-in carrying both flavors. The dispatcher
 * only reads `types` / `getData(mime)` and `event.shiftKey`.
 */
function fakeClipboardEvent(plain: string, html: string): ClipboardEvent {
  const dt = {
    types: ['text/plain', 'text/html'],
    getData: (mime: string) => (mime === 'text/plain' ? plain : mime === 'text/html' ? html : ''),
  };
  return { clipboardData: dt } as unknown as ClipboardEvent;
}

/** Paste a foreign payload through the production dispatcher. */
function pasteForeign(plain: string, html: string): JSONContent {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const view = new EditorView(mount, {
    state: EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph')]),
    }),
    handlePaste: createHandlePaste({ mdManager }),
  });
  views.push(view);
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
  view.pasteHTML(html, fakeClipboardEvent(plain, html));
  return view.state.doc.toJSON() as JSONContent;
}

describe('route 1 — Mod-U typed underline', () => {
  test('the chord applies a real underline mark', () => {
    const { editor } = mount();
    typeUnderlined(editor, 'plain ', 'under');
    expect(marksOn(editor.getJSON(), 'under')).toContain('underline');
  });

  test('the typed mark serializes to <u> bytes', () => {
    const { editor } = mount();
    typeUnderlined(editor, 'plain ', 'under');
    expect(rederive(editor.getJSON()).bytes).toContain('plain <u>under</u>');
  });

  test('the typed mark survives re-derivation', () => {
    const { editor } = mount();
    typeUnderlined(editor, 'plain ', 'under');
    const { next } = rederive(editor.getJSON());
    expect(textUnderMark(next, 'underline')).toBe('under');
  });

  test('re-derivation reaches a byte fixed point', () => {
    const { editor } = mount();
    typeUnderlined(editor, 'plain ', 'under');
    let doc: JSONContent = editor.getJSON();
    const first = rederive(doc);
    doc = first.next;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const step = rederive(doc);
      expect(step.bytes).toBe(first.bytes);
      doc = step.next;
    }
  });

  test('underline coexists with strong, emphasis and code on one run', () => {
    const { editor } = mount();
    editor.commands.insertContent('x');
    editor.commands.setTextSelection({ from: 1, to: 2 });
    for (const chord of ['Mod-u', 'Mod-b', 'Mod-i', 'Mod-e']) {
      editor.commands.keyboardShortcut(chord);
    }
    const applied = marksOn(editor.getJSON(), 'x');
    expect(applied).toEqual(expect.arrayContaining(['underline', 'strong', 'emphasis', 'code']));

    const { next } = rederive(editor.getJSON());
    expect(textUnderMark(next, 'underline')).toBe('x');
  });
});

describe('route 2 — foreign paste carrying <u>', () => {
  const WORD = {
    plain: 'plain under tail',
    html: '<p class="MsoNormal">plain <u>under</u> tail</p>',
  };

  test('a pasted <u> run lands as underline, not emphasis', () => {
    const pasted = pasteForeign(WORD.plain, WORD.html);
    expect(textUnderMark(pasted, 'underline')).toBe('under');
    expect(textUnderMark(pasted, 'emphasis')).toBe('');
  });

  test('a pasted <ins> run lands as underline too', () => {
    const pasted = pasteForeign('plain under tail', '<p>plain <ins>under</ins> tail</p>');
    expect(textUnderMark(pasted, 'underline')).toBe('under');
  });

  /**
   * The whole `htmlToMdast` → `expandUnderlineWrappers` → promoter → serialize
   * chain has to keep the authored spelling. Without the bytes assertion an
   * `ins`-to-`u` slip anywhere along it would still leave an underline mark
   * and pass every mark-level check.
   */
  test('a pasted <ins> run serializes back as <ins>, not <u>', () => {
    const pasted = pasteForeign('plain under tail', '<p>plain <ins>under</ins> tail</p>');
    const { bytes, next } = rederive(pasted);
    expect(bytes).toContain('<ins>under</ins>');
    expect(bytes).not.toContain('<u>');
    expect(textUnderMark(next, 'underline')).toBe('under');
  });

  test('a pasted <u> run serializes back as <u>, not <ins>', () => {
    const { bytes } = rederive(pasteForeign(WORD.plain, WORD.html));
    expect(bytes).toContain('<u>under</u>');
    expect(bytes).not.toContain('<ins>');
  });

  test('pasted underline survives re-derivation', () => {
    const { next } = rederive(pasteForeign(WORD.plain, WORD.html));
    expect(textUnderMark(next, 'underline')).toBe('under');
  });

  test('a pasted italic run is still italic (no over-claim)', () => {
    const pasted = pasteForeign('plain slanted tail', '<p>plain <i>slanted</i> tail</p>');
    expect(textUnderMark(pasted, 'emphasis')).toBe('slanted');
    expect(textUnderMark(pasted, 'underline')).toBe('');
  });

  /**
   * The underline run has to survive in every container the clipboard can put
   * it in, not just inside a `<p>`. mdast's `html` node is flow-ambiguous, so
   * a converter that emits the tags directly shatters the surrounding prose
   * into separate blocks wherever the run is not already inside a
   * phrasing-only container — the browser's own fragment wrapper for a partial
   * in-paragraph selection and `<li>` content both hit that. Each case asserts
   * the underline landed AND the prose around it stayed in one block.
   */
  const CONTAINERS = [
    {
      name: 'browser StartFragment wrapper',
      html: '<!--StartFragment-->a <u>q</u> b<!--EndFragment-->',
    },
    { name: 'bare root-level run', html: 'a <u>q</u> b' },
    { name: 'paragraph', html: '<p>a <u>q</u> b</p>' },
    { name: 'list item', html: '<ul><li>a <u>q</u> b</li></ul>' },
    { name: 'table cell', html: '<table><tr><td>a <u>q</u> b</td></tr></table>' },
    { name: 'heading', html: '<h2>a <u>q</u> b</h2>' },
  ] as const;

  for (const { name, html } of CONTAINERS) {
    test(`underline survives a paste inside a ${name}`, () => {
      const pasted = pasteForeign('a q b', html);
      expect(textUnderMark(pasted, 'underline')).toBe('q');
      expect(textUnderMark(pasted, 'emphasis')).toBe('');
      // The prose around the run must not have been split across blocks.
      expect(allText(pasted)).toContain('a q b');
    });
  }
});

describe('the underline mark renders visibly', () => {
  test('the mark renders as a <u> element in the editing surface', () => {
    const { editor, container } = mount();
    typeUnderlined(editor, 'plain ', 'under');
    const rendered = container.querySelector('u');
    expect(rendered).not.toBeNull();
    expect(rendered?.textContent).toBe('under');
  });
});
