import type { Editor } from '@tiptap/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  firstLinkAttrs,
  linkHrefs,
  mountLightEditor,
  mountProjectionEditor,
  type ProjectionEditorRig,
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

describe('inline-link input rule — exclusions', () => {
  test('does not fire inside a code block', async () => {
    const editor = makeEditor({ content: '<pre><code>x</code></pre>' });
    try {
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

describe('inline-link input rule — one undo restores the literal, under the projection binding', () => {
  function mountAtEnd(): ProjectionEditorRig {
    const rig = mountProjectionEditor('seed\n', [InlineLinkInputRule]);
    rig.editor.commands.setTextSelection(rig.editor.state.doc.content.size - 1);
    return rig;
  }

  test('one undo retracts the typed [text](url) with its conversion, because the literal bytes already parse as the link', async () => {
    const rig = mountAtEnd();
    const { editor } = rig;
    try {
      await flushMicrotasksAndTimers();
      rig.undoManager.stopCapturing();
      typeText(editor, ' [docs](https://example.com)');
      await flushMicrotasksAndTimers();
      expect(editor.state.doc.textContent).toBe('seed docs');
      expect(linkHrefs(editor)).toEqual(['https://example.com']);

      rig.undoManager.undo();
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toBe('seed');
      expect(linkHrefs(editor)).toEqual([]);
      expect(rig.ytext.toString()).toBe('seed\n');
    } finally {
      rig.destroy();
    }
  });

  test('typing after a conversion stays its own undo step (no merge into the collapse)', async () => {
    const rig = mountAtEnd();
    const { editor } = rig;
    try {
      await flushMicrotasksAndTimers();
      rig.undoManager.stopCapturing();
      typeText(editor, ' [docs](https://example.com)');
      await flushMicrotasksAndTimers();
      expect(editor.state.doc.textContent).toBe('seed docs');

      typeText(editor, ' more');
      await flushMicrotasksAndTimers();
      expect(editor.state.doc.textContent).toBe('seed docs more');

      rig.undoManager.undo();
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toBe('seed docs');
      expect(linkHrefs(editor)).toEqual(['https://example.com']);
    } finally {
      rig.destroy();
    }
  });
});
