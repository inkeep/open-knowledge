/**
 * Typed `$$…$$` / `$…$` input rule — conversion, currency safety, exclusion
 * contexts, and the one-undo-restores-the-literal contract against a real
 * y-undo binding.
 *
 * Input rules fire only from `handleTextInput`, so these rigs type through
 * `view.someProp('handleTextInput', …)` with the same unhandled-fallback
 * insertion the real DOM input path performs — a bare `insertText` dispatch
 * never triggers a rule.
 */

import { MathInline } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { mountCollabEditor, mountLightEditor, readUndoManager } from './editor-rig.test-helper';
import { MathInputRule } from './math-input-rule';
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
  return mountLightEditor({
    content: opts.content,
    extensions: [MathInline, MathInputRule],
  });
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

/** All `mathInline` atoms in the doc, in order. Returned as their attr snapshot
 *  so a test can assert on `formula` + `sourceDelimiter` in one shot. */
function mathAtoms(editor: Editor): Array<{ formula: string; sourceDelimiter: string | null }> {
  const atoms: Array<{ formula: string; sourceDelimiter: string | null }> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'mathInline') {
      atoms.push({
        formula: (node.attrs.formula as string) ?? '',
        sourceDelimiter: (node.attrs.sourceDelimiter as string | null) ?? null,
      });
    }
    return undefined;
  });
  return atoms;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

describe('math input rule — conversion', () => {
  test('typing `$$x+y$$` collapses to a mathInline atom on the closing `$$`', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, '$$x+y$$');
      await flushMicrotasksAndTimers();

      const atoms = mathAtoms(editor);
      expect(atoms).toEqual([{ formula: 'x+y', sourceDelimiter: '$$' }]);
      // The raw literal is gone from textContent; PM renders the atom as a
      // single non-text position.
      expect(editor.state.doc.textContent).toBe('');
    } finally {
      editor.destroy();
    }
  });

  test('typing `$c=d$` collapses to a mathInline atom carrying the pandoc-style single-delim', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, '$c=d$');
      await flushMicrotasksAndTimers();

      expect(mathAtoms(editor)).toEqual([{ formula: 'c=d', sourceDelimiter: '$' }]);
    } finally {
      editor.destroy();
    }
  });

  test('mid-paragraph `$…$` after preceding text still collapses', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, 'sum: $a+b$');
      await flushMicrotasksAndTimers();

      expect(mathAtoms(editor)).toEqual([{ formula: 'a+b', sourceDelimiter: '$' }]);
      expect(editor.state.doc.textContent).toBe('sum: ');
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Currency safety — pandoc-style guard for the single-dollar form
// ---------------------------------------------------------------------------

describe('math input rule — currency safety', () => {
  test('`$5.00` typed alone stays literal (single trailing `$` never fires)', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, '$5.00');
      await flushMicrotasksAndTimers();

      expect(mathAtoms(editor)).toEqual([]);
      expect(editor.state.doc.textContent).toBe('$5.00');
    } finally {
      editor.destroy();
    }
  });

  test('`between $5 and $10` — pandoc lookbehind blocks the `$…$` around a real price range', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, 'between $5 and $10');
      await flushMicrotasksAndTimers();

      // Opening `$` after "and " has a space before it (allowed), but content
      // is `5 and $` — the `\s$` inside forces a mismatch; even if it matched
      // once, the leading `5 and ` would violate the trim-safe outer edges.
      expect(mathAtoms(editor)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  test('`foo$x$` — opening `$` preceded by a word char is refused', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, 'foo$x$');
      await flushMicrotasksAndTimers();

      expect(mathAtoms(editor)).toEqual([]);
      expect(editor.state.doc.textContent).toBe('foo$x$');
    } finally {
      editor.destroy();
    }
  });

  test('`$ x $` — whitespace-flanked content stays literal (pandoc contract)', async () => {
    const editor = makeEditor();
    try {
      typeText(editor, '$ x $');
      await flushMicrotasksAndTimers();

      expect(mathAtoms(editor)).toEqual([]);
      expect(editor.state.doc.textContent).toBe('$ x $');
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Exclusion contexts
// ---------------------------------------------------------------------------

describe('math input rule — exclusions', () => {
  test('does not fire inside a code block', async () => {
    const editor = makeEditor({ content: '<pre><code>x</code></pre>' });
    try {
      // Caret at the end of the code block content.
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      typeText(editor, '$$a+b$$');
      await flushMicrotasksAndTimers();

      expect(mathAtoms(editor)).toEqual([]);
      expect(editor.state.doc.textContent).toBe('x$$a+b$$');
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Undo isolation (real y-undo binding)
// ---------------------------------------------------------------------------

describe('math input rule — one undo restores the literal', () => {
  test('a single undo brings back `$$x+y$$` as raw text and drops the atom', async () => {
    const ydoc = new Y.Doc();
    const editor = mountCollabEditor(ydoc, [MathInline, MathInputRule]);
    try {
      typeText(editor, '$$x+y$$');
      await flushMicrotasksAndTimers();
      expect(mathAtoms(editor)).toEqual([{ formula: 'x+y', sourceDelimiter: '$$' }]);

      const undoManager = readUndoManager(editor);
      expect(undoManager).not.toBeNull();
      undoManager?.undo();
      await flushMicrotasksAndTimers();

      expect(mathAtoms(editor)).toEqual([]);
      expect(editor.state.doc.textContent).toBe('$$x+y$$');
    } finally {
      editor.destroy();
      ydoc.destroy();
    }
  });

  test('typing after a collapse stays its own undo step (no merge into the collapse)', async () => {
    const ydoc = new Y.Doc();
    const editor = mountCollabEditor(ydoc, [MathInline, MathInputRule]);
    try {
      typeText(editor, '$$x+y$$');
      await flushMicrotasksAndTimers();
      expect(mathAtoms(editor)).toEqual([{ formula: 'x+y', sourceDelimiter: '$$' }]);

      // Keystrokes after the collapse land within captureTimeout of it; the
      // closing stopCapturing must keep them OUT of the collapse's undo item.
      typeText(editor, ' more');
      await flushMicrotasksAndTimers();
      expect(editor.state.doc.textContent).toBe(' more');

      const undoManager = readUndoManager(editor);
      undoManager?.undo();
      await flushMicrotasksAndTimers();

      // Only the trailing typing is removed; the converted atom survives.
      expect(mathAtoms(editor)).toEqual([{ formula: 'x+y', sourceDelimiter: '$$' }]);
      expect(editor.state.doc.textContent).toBe('');
    } finally {
      editor.destroy();
      ydoc.destroy();
    }
  });
});
