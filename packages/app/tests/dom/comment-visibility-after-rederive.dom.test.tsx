/**
 * Typed comment syntax must stay visible in the WYSIWYG.
 *
 * The comment promoter claims a literal `<!-- … -->` / `%%…%%` run on the
 * next re-derivation, so prose a user typed becomes a `comment` mark or a
 * `commentBlock` node. When those bindings render `display: none` the text
 * leaves the editing surface entirely while the bytes on disk stay perfect:
 * the author sees their sentence delete itself and has no way to get it back
 * from the WYSIWYG. Comments are annotation, not deletion — the editing
 * surface shows them dimmed (Obsidian live-preview behaviour) and only
 * reading surfaces hide them.
 *
 * The rig is the production re-derivation, not a re-implementation of it:
 * Observer A serializes the fragment into Y.Text, Observer B splits the
 * frontmatter region off and re-parses the body with `parseWithFallback`.
 * A test that only checked `parse()` would miss the composition that
 * actually re-derives a live document.
 *
 * Visibility is read off the rendered ProseMirror DOM rather than the node
 * tree, because "the text is still in the document" is exactly the property
 * that held while the bug was live.
 */

import { MarkdownManager, sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { cleanup } from '@testing-library/react';
import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';

const mdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});

const mounted: Array<{ editor: Editor; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { editor, container } of mounted.splice(0)) {
    editor.destroy();
    container.remove();
  }
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

/**
 * Text a reader can actually see. Skips any subtree the renderer hid with an
 * inline `display: none` or `hidden`, which is what made the typed run
 * vanish. `textContent` would report the hidden run as present and pass.
 */
function visibleText(root: HTMLElement): string {
  let out = '';
  const walk = (node: ChildNode): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (
      node.style.display === 'none' ||
      node.style.visibility === 'hidden' ||
      node.hasAttribute('hidden')
    )
      return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return out;
}

/** Type a literal run with the input-rule pipeline bypassed, as paste does. */
function insertLiteral(editor: Editor, text: string): void {
  editor.view.dispatch(editor.state.tr.insertText(text));
}

describe('typed comment syntax survives re-derivation visibly', () => {
  const CASES = [
    { name: 'html, whole paragraph', typed: '<!-- hidden note -->', visible: 'hidden note' },
    { name: 'percent, whole paragraph', typed: '%%hidden note%%', visible: 'hidden note' },
    { name: 'html, mid paragraph', typed: 'before <!-- mid --> after', visible: 'mid' },
    { name: 'percent, mid paragraph', typed: 'before %%mid%% after', visible: 'mid' },
  ] as const;

  for (const { name, typed, visible } of CASES) {
    test(`${name}: the typed run is visible before AND after re-derivation`, () => {
      const { editor, container } = mount();
      insertLiteral(editor, typed);
      expect(visibleText(container)).toContain(visible);

      const { next } = rederive(editor.getJSON());
      editor.commands.setContent(next);

      expect(visibleText(container)).toContain(visible);
    });

    test(`${name}: the bytes are unchanged by the re-derivation`, () => {
      const { editor } = mount();
      insertLiteral(editor, typed);

      // Iterate the re-derivation on its own rather than through the editor:
      // a mounted editor appends a TrailingNode, which adds a newline that
      // belongs to the editor's affordance rather than to the round-trip.
      let doc: JSONContent = editor.getJSON();
      for (let iteration = 0; iteration < 4; iteration += 1) {
        const step = rederive(doc);
        expect(step.bytes).toBe(`${typed}\n`);
        doc = step.next;
      }
    });
  }
});

describe('a comment stays marked as a comment while it is visible', () => {
  test('the promoted run renders inside the comment mark element', () => {
    const { editor, container } = mount();
    insertLiteral(editor, 'before %%mid%% after');
    editor.commands.setContent(rederive(editor.getJSON()).next);

    const marker = container.querySelector('[data-comment-mark]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toBe('mid');
  });

  test('the promoted block renders inside the comment block element', () => {
    const { editor, container } = mount();
    insertLiteral(editor, '<!-- hidden note -->');
    editor.commands.setContent(rederive(editor.getJSON()).next);

    const marker = container.querySelector('[data-comment-block]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain('hidden note');
  });

  test('a deliberately applied comment mark is visible too', () => {
    const { editor, container } = mount();
    editor.commands.setComment();
    insertLiteral(editor, 'deliberate note');

    expect(visibleText(container)).toContain('deliberate note');
    expect(container.querySelector('[data-comment-mark]')).not.toBeNull();
  });
});

describe('comment content stays out of the clipboard', () => {
  test('both bindings keep the clipboard opt-out stamp', () => {
    const { editor, container } = mount();
    insertLiteral(editor, 'before %%mid%% after');
    editor.commands.setContent(rederive(editor.getJSON()).next);
    expect(
      container.querySelector('[data-comment-mark]')?.getAttribute('data-clipboard-omit'),
    ).toBe('true');

    const block = mount();
    insertLiteral(block.editor, '<!-- hidden note -->');
    block.editor.commands.setContent(rederive(block.editor.getJSON()).next);
    expect(
      block.container.querySelector('[data-comment-block]')?.getAttribute('data-clipboard-omit'),
    ).toBe('true');
  });
});
