/**
 * Typed `[text](url)` input rule — conversion + href policy, exclusion
 * contexts, and the one-undo-restores-the-literal contract against a real
 * y-undo binding.
 *
 * Input rules fire only from `handleTextInput`, so these rigs type through
 * `view.someProp('handleTextInput', …)` with the same unhandled-fallback
 * insertion the real DOM input path performs — a bare `insertText` dispatch
 * never triggers a rule.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import {
  firstLinkAttrs,
  linkHrefs,
  mountCollabEditor,
  mountLightEditor,
  readUndoManager,
} from './editor-rig.test-helper';
import { InlineLinkInputRule } from './inline-link-input-rule';
import { flushMicrotasksAndTimers, installDomGlobals } from './walk-currency-test-harness';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

function makeEditor(opts: { content?: string } = {}): Editor {
  return mountLightEditor({ content: opts.content, extensions: [InlineLinkInputRule] });
}

/**
 * Type text the way the DOM input path does: each character goes through
 * `handleTextInput` (where input rules run) and falls back to a plain
 * insertion when no rule claims it.
 */
function typeText(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const deflt = () => editor.state.tr.insertText(char, from, to);
    const handled = editor.view.someProp('handleTextInput', (handleTextInput) =>
      handleTextInput(editor.view, from, to, char, deflt),
    );
    if (!handled) {
      editor.view.dispatch(deflt());
    }
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

describe('inline-link input rule — conversion', () => {
  test('typing [text](url) converts to linked display text on the closing paren', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, '[docs](https://example.com)');
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toBe('docs');
      const attrs = firstLinkAttrs(editor);
      expect(attrs?.href).toBe('https://example.com');
      expect(attrs?.linkStyle).toBe('inline');
    } finally {
      editor.destroy();
    }
  });

  test('a relative target is allowed (internal-link contract)', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, '[guide](/docs/start)');
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toBe('guide');
      expect(firstLinkAttrs(editor)?.href).toBe('/docs/start');
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Href policy
// ---------------------------------------------------------------------------

describe('inline-link input rule — href policy', () => {
  test('an empty URL [text]() stays literal', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, '[x]()');
      await flushMicrotasksAndTimers();
      expect(editor.state.doc.textContent).toBe('[x]()');
      expect(linkHrefs(editor)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  test('a disallowed scheme leaves the literal untouched', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, '[x](javascript:alert)');
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toBe('[x](javascript:alert)');
      expect(linkHrefs(editor)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Exclusion contexts
// ---------------------------------------------------------------------------

describe('inline-link input rule — exclusions', () => {
  test('does not fire inside a code block', async () => {
    const editor = makeEditor({ content: '<pre><code>x</code></pre>' });
    try {
      // Caret at the end of the code block content.
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      typeText(editor, '[a](https://b.com)');
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toBe('x[a](https://b.com)');
      expect(linkHrefs(editor)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  test('wikilink shorthand is excluded structurally', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, '[[Page]]');
      await flushMicrotasksAndTimers();

      expect(linkHrefs(editor)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Undo isolation (real y-undo binding)
// ---------------------------------------------------------------------------

describe('inline-link input rule — one undo restores the literal', () => {
  test('a single undo brings back [text](url) with the text intact', async () => {
    const ydoc = new Y.Doc();
    const editor = mountCollabEditor(ydoc, [InlineLinkInputRule]);
    try {
      typeText(editor, '[docs](https://example.com)');
      await flushMicrotasksAndTimers();
      expect(editor.state.doc.textContent).toBe('docs');
      expect(linkHrefs(editor)).toEqual(['https://example.com']);

      const undoManager = readUndoManager(editor);
      expect(undoManager).not.toBeNull();
      undoManager?.undo();
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toBe('[docs](https://example.com)');
      expect(linkHrefs(editor)).toEqual([]);
    } finally {
      editor.destroy();
      ydoc.destroy();
    }
  });

  test('typing after a conversion stays its own undo step (no merge into the collapse)', async () => {
    const ydoc = new Y.Doc();
    const editor = mountCollabEditor(ydoc, [InlineLinkInputRule]);
    try {
      typeText(editor, '[docs](https://example.com)');
      await flushMicrotasksAndTimers();
      expect(editor.state.doc.textContent).toBe('docs');

      // Keystrokes after the collapse land within captureTimeout of it; the
      // closing stopCapturing must keep them OUT of the collapse's undo item.
      typeText(editor, ' more');
      await flushMicrotasksAndTimers();
      expect(editor.state.doc.textContent).toBe('docs more');

      const undoManager = readUndoManager(editor);
      undoManager?.undo();
      await flushMicrotasksAndTimers();

      // Only the trailing typing is removed; the converted link survives.
      expect(editor.state.doc.textContent).toBe('docs');
      expect(linkHrefs(editor)).toEqual(['https://example.com']);
    } finally {
      editor.destroy();
      ydoc.destroy();
    }
  });
});
