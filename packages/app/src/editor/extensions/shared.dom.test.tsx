import { COMMAND_IDENTITIES } from '@inkeep/open-knowledge-core';
import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, test } from 'vitest';
import { pressEditorKey } from '../editor-rig.test-helper';
import { sharedExtensions } from './shared';

/**
 * Electron accelerator syntax ("CmdOrCtrl+Shift+D") to the `Mod-Shift-d` form
 * `pressEditorKey` speaks. Returns null for accelerators whose final token is
 * not a plain character (F-keys, named keys), which the editor keymap does not
 * bind and `shortcutToKeydownEvent` would encode wrongly anyway.
 */
function acceleratorToTiptapShortcut(accelerator: string): string | null {
  const parts = accelerator.split('+');
  const key = parts[parts.length - 1];
  if (key === undefined || key.length !== 1) return null;
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (part === 'CmdOrCtrl' || part === 'CommandOrControl') modifiers.push('Mod');
    else if (part === 'Cmd' || part === 'Command' || part === 'Super') modifiers.push('Cmd');
    else if (part === 'Ctrl' || part === 'Control') modifiers.push('Ctrl');
    else if (part === 'Alt' || part === 'Option') modifiers.push('Alt');
    else if (part === 'Shift') modifiers.push('Shift');
    else return null;
  }
  return [...modifiers, key.toLowerCase()].join('-');
}

describe('sharedExtensions module graph', () => {
  afterEach(() => {
    cleanup();
  });

  test('loads under the DOM test substrate without initialization cycles', async () => {
    expect(sharedExtensions.length).toBeGreaterThan(0);
  });

  // Helper — wait for Tiptap's `blur` command to flush. Tiptap defers the
  // DOM `.blur()` call to a `requestAnimationFrame` callback (see
  // `@tiptap/core` commands/blur), so a synchronous keydown dispatch
  // returns before focus actually transitions. Two rAF ticks is
  // sufficient in jsdom and stays under any plausible CI flake threshold.
  const flushRaf = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

  // Dispatch a real `keydown` event against the ProseMirror DOM, which is
  // what users actually do — `editor.commands.keyboardShortcut(name)` in
  // jsdom returns true but does not run the keymap-chain side effects
  // observably for Tab/Escape. The native `dispatchEvent` goes through
  // PM's `handleKeyDown` plugin path the same way a browser keydown does.
  const dispatchKey = (editor: Editor, key: string, opts: { shiftKey?: boolean } = {}) =>
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code: key,
        shiftKey: opts.shiftKey ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );

  test('Escape on a top-level NodeSelection blurs the editor (WCAG 2.1.2 keyboard exit, paired with TabFocusTrap)', async () => {
    // TabFocusTrap consumes every fall-through Tab/Shift-Tab to keep focus
    // inside the editor; WCAG 2.1.2 "No Keyboard Trap" (Level A) then
    // requires a keyboard mechanism to leave. The path documented in
    // tab-focus-trap.ts: Esc selects the parent node → Esc again on a
    // top-level NodeSelection blurs and releases focus to the next
    // tabbable element OUTSIDE the editor. This test pins the second hop
    // — without it, keyboard-only users have no way out.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<p>alpha</p>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.view.dom.focus();
      expect(document.activeElement).toBe(editor.view.dom);

      // Place a top-level NodeSelection on the paragraph (depth-0 parent).
      editor.commands.setNodeSelection(0);
      expect(editor.state.selection.$from.depth).toBe(0);

      dispatchKey(editor, 'Escape');
      await flushRaf();

      // Focus released to the next tabbable element — in jsdom, the body
      // catches focus when nothing else is tabbable.
      expect(document.activeElement).not.toBe(editor.view.dom);
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('Escape on a TextSelection inside a paragraph escalates to NodeSelection (does NOT blur on first press)', async () => {
    // The blur path is ONLY for top-level NodeSelection — first Esc on
    // TextSelection must still escalate to NodeSelection so the user gets
    // the Notion-style "Esc once to select the block, Esc again to exit"
    // affordance. Pins that the depth check doesn't accidentally blur on
    // the first Esc press.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<p>alpha</p>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.view.dom.focus();
      editor.commands.setTextSelection({ from: 1, to: 6 });
      expect(document.activeElement).toBe(editor.view.dom);

      dispatchKey(editor, 'Escape');
      await flushRaf();

      // First Esc must NOT blur — it elevates TextSelection → NodeSelection.
      expect(document.activeElement).toBe(editor.view.dom);
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('Tab inside a code block inserts 2 spaces (Prettier/Biome convention; the TabFocusTrap fall-through must NOT swallow it)', () => {
    // The two pieces of the Tab story have to compose: the global
    // `TabFocusTrap` (priority 1) keeps Tab from escaping the editor when
    // no other handler fires, but inside a code block, `CodeBlockFidelity`
    // (priority 60) must claim Tab first and insert spaces. If the trap's
    // priority ever crept above the code-block keymap, code authoring
    // would silently break — Tab would be a no-op inside ``` fences.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<pre><code></code></pre>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.commands.focus();
      // Caret inside the empty code block (position 1: just inside <pre>).
      editor.commands.setTextSelection(1);
      dispatchKey(editor, 'Tab');
      // Two ASCII spaces inserted at the caret. `editor.getText()` joins
      // block contents with `\n`; the code-block's content is just `'  '`.
      expect(editor.getText().replace(/\n+$/, '')).toBe('  ');
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('Shift-Tab inside a code block removes up to 2 leading spaces (symmetric unindent)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<pre><code>    hello</code></pre>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.commands.focus();
      // Caret somewhere on the line (after the leading spaces).
      editor.commands.setTextSelection(7);
      dispatchKey(editor, 'Tab', { shiftKey: true });
      // First Shift-Tab pulls the line's leading spaces from 4 → 2.
      expect(editor.getText().replace(/\n+$/, '')).toBe('  hello');
      dispatchKey(editor, 'Tab', { shiftKey: true });
      // Second Shift-Tab pulls 2 → 0.
      expect(editor.getText().replace(/\n+$/, '')).toBe('hello');
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('advertised strikethrough shortcut toggles strike formatting', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<p>alpha</p>',
      extensions: sharedExtensions,
      editable: true,
    });

    try {
      editor.commands.setTextSelection({ from: 1, to: 6 });

      expect(editor.isActive('strike')).toBe(false);
      pressEditorKey(editor, 'Mod-Shift-x');
      expect(editor.isActive('strike')).toBe(true);
      expect(editor.getHTML()).toContain('<s>alpha</s>');
    } finally {
      editor.destroy();
      container.remove();
    }
  });
  test('no menu accelerator is claimed by the editor keymap', () => {
    // The surface that let a shipped chord through. Menu accelerators are
    // checked against this app's shortcut registry, its own menu template and
    // Electron's role defaults — three lists we author. The editor's bindings
    // are the fourth, and they are not in this repo at all: TipTap extensions
    // carry their own defaults, so a chord can grep clean everywhere we look
    // and still be taken. Shift+Mod+B reached QA that way, where it wrapped
    // the caret's paragraph in a blockquote and persisted that to disk instead
    // of running the command.
    //
    // Accelerators are read off COMMAND_IDENTITIES rather than listed, so a
    // rebind is re-checked here instead of re-trusted, and a dependency bump
    // that newly claims a live chord turns this red.
    const accelerators = COMMAND_IDENTITIES.flatMap((identity) =>
      (identity.menu ?? []).flatMap((placement) =>
        placement.accelerator === undefined
          ? []
          : [{ id: identity.id, accelerator: placement.accelerator }],
      ),
    );
    expect(accelerators.length).toBeGreaterThan(0);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      content: '<p>alpha</p>',
      extensions: sharedExtensions,
      editable: true,
    });

    const claimed: { id: string; accelerator: string; handled: boolean; docMoved: boolean }[] = [];
    // An accelerator the mapper cannot express must stay visible. Skipping it
    // silently is how a chord passes a sweep that never actually pressed it —
    // the same blind spot that let a chord ship on top of the editor's
    // blockquote binding. Named keys are exempt because `pressEditorKey` would
    // encode them wrongly, not because they are safe: TipTap's base keymap does
    // bind Mod-Delete and Mod-Backspace, so a future named-key accelerator has
    // to be a decision someone makes here.
    const unmappable: string[] = [];
    try {
      for (const entry of accelerators) {
        const shortcut = acceleratorToTiptapShortcut(entry.accelerator);
        if (shortcut === null) {
          unmappable.push(entry.accelerator);
          continue;
        }
        editor.commands.setContent('<p>alpha</p>');
        editor.commands.setTextSelection({ from: 1, to: 1 });
        const { handled, docMoved } = pressEditorKey(editor, shortcut);
        if (handled || docMoved) claimed.push({ ...entry, handled, docMoved });
      }
    } finally {
      editor.destroy();
      container.remove();
    }

    expect(claimed).toEqual([]);
    expect(unmappable.sort()).toEqual(['Alt+Left', 'Alt+Right', 'CmdOrCtrl+Delete']);
  });
});
