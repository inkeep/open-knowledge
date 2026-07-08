/**
 * Typed-URL autolink plugin — origin guard, detection, exclusions, and the
 * deferred separate-dispatch mechanism.
 *
 * Two rigs, both real ProseMirror EditorViews (jsdom globals via the shared
 * walk-currency harness), so the plugin's `view()` hook, `view.composing`,
 * and its microtask `view.dispatch` all run for real:
 *
 *  - a light rig (StarterKit + the real link mark + this plugin) with an
 *    injected `isActiveEditor` predicate, for deterministic coverage of
 *    detection, the token policy, the exclusion contexts, the active-editor
 *    gate, IME, and the position re-validation abort; and
 *  - a `Collaboration`-bound rig where a peer edit arrives through the REAL
 *    y-sync plugin (a second Y.Doc synced via `Y.applyUpdate`), proving the
 *    origin guard skips a genuinely CRDT-tagged transaction while a local edit
 *    in the same binding still converts. The same rig's real y-undo manager
 *    carries the undo-isolation coverage: one undo removes only the
 *    conversion's mark (typed text and trailing space intact), redo re-applies
 *    it, and follow-up typing never merges into the mark's undo step.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Editor } from '@tiptap/core';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {
  firstLinkAttrs,
  firstLinkHref,
  insertLocal,
  linkHrefs,
  mountCollabEditor,
  mountLightEditor,
  readUndoManager,
} from './editor-rig.test-helper';
import { GfmAutolink, PREVENT_AUTOLINK_META } from './gfm-autolink-plugin';
import {
  appendToFirstParagraph,
  flushMicrotasksAndTimers,
  installDomGlobals,
  seedFragmentParagraph,
} from './walk-currency-test-harness';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

// ---------------------------------------------------------------------------
// Rigs + helpers
// ---------------------------------------------------------------------------

function makeLightEditor(opts: { content?: string; isActiveEditor?: () => boolean } = {}): Editor {
  return mountLightEditor({
    content: opts.content,
    extensions: [GfmAutolink.configure({ isActiveEditor: opts.isActiveEditor ?? (() => true) })],
  });
}

/** Collab rig with this plugin installed; `isActiveEditor: () => true` keeps
 *  the origin guard (not focus) as the only thing that can block an edit. */
function makeCollabEditor(ydoc: Y.Doc): Editor {
  return mountCollabEditor(ydoc, [GfmAutolink.configure({ isActiveEditor: () => true })]);
}

// ---------------------------------------------------------------------------
// Detection + token policy
// ---------------------------------------------------------------------------

describe('typed autolink — conversion', () => {
  test('typing a URL then a space converts it to a gfm-autolink link mark', async () => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, 'https://example.com ', 1);
      await flushMicrotasksAndTimers();

      const attrs = firstLinkAttrs(editor);
      expect(attrs?.href).toBe('https://example.com');
      expect(attrs?.linkStyle).toBe('gfm-autolink');
      // The typed text and its trailing space are untouched — only a mark added.
      expect(editor.state.doc.textContent).toBe('https://example.com ');
    } finally {
      editor.destroy();
    }
  });

  test('pressing Enter after a URL converts the trailing token', async () => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, 'https://example.com', 1);
      // Caret at the end of the URL, then split the block (Enter).
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.commands.splitBlock();
      await flushMicrotasksAndTimers();

      expect(firstLinkAttrs(editor)?.linkStyle).toBe('gfm-autolink');
      expect(firstLinkHref(editor)).toBe('https://example.com');
    } finally {
      editor.destroy();
    }
  });

  test('an explicit-scheme dotless host converts (dotted-domain rule is schemeless-only)', async () => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, 'http://localhost:5174/#/doc ', 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkHref(editor)).toBe('http://localhost:5174/#/doc');
      expect(firstLinkAttrs(editor)?.linkStyle).toBe('gfm-autolink');
    } finally {
      editor.destroy();
    }
  });

  test('www and email tokens get the pipeline-correct href', async () => {
    const www = makeLightEditor();
    try {
      insertLocal(www, 'www.example.com ', 1);
      await flushMicrotasksAndTimers();
      // The markdown pipeline prepends http:// (not https) to bare www tokens.
      expect(firstLinkHref(www)).toBe('http://www.example.com');
    } finally {
      www.destroy();
    }

    const email = makeLightEditor();
    try {
      insertLocal(email, 'a@b.com ', 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkHref(email)).toBe('mailto:a@b.com');
    } finally {
      email.destroy();
    }
  });

  test.each([
    'AGENTS.md ',
    'example.com ',
    'localhost:5173 ',
    'v1.2.3 ',
  ])('non-GFM token %j is left as plain text', async (typed) => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, typed, 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)).toBeNull();
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Origin + active-editor guards
// ---------------------------------------------------------------------------

describe('typed autolink — guards', () => {
  test('a transaction tagged with ySyncPluginKey meta never converts', async () => {
    const editor = makeLightEditor();
    try {
      const tr = editor.state.tr.insertText('https://example.com ', 1, 1);
      // Stand in for a remote peer / agent / disk / observer transaction.
      tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
      editor.view.dispatch(tr);
      await flushMicrotasksAndTimers();

      expect(firstLinkAttrs(editor)).toBeNull();
      expect(editor.state.doc.textContent).toBe('https://example.com ');
    } finally {
      editor.destroy();
    }
  });

  test('a transaction carrying preventAutolink meta never converts', async () => {
    const editor = makeLightEditor();
    try {
      const tr = editor.state.tr.insertText('https://example.com ', 1, 1);
      tr.setMeta(PREVENT_AUTOLINK_META, true);
      editor.view.dispatch(tr);
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  test('a non-active (backgrounded) editor never converts', async () => {
    const editor = makeLightEditor({ isActiveEditor: () => false });
    try {
      insertLocal(editor, 'https://example.com ', 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  test('no conversion while IME composition is active at dispatch time', async () => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, 'https://example.com ', 1);
      // Composition still active when the deferred flush runs -> abort. Shadow
      // the PUBLIC `composing` getter on the view instance rather than mutating
      // the private `input` slot it reads: if PM ever restructures its internal
      // composition state, a slot mutation silently stops reaching the getter
      // and this guard test goes false-green.
      Object.defineProperty(editor.view, 'composing', { get: () => true, configurable: true });
      try {
        await flushMicrotasksAndTimers();
        expect(firstLinkAttrs(editor)).toBeNull();
      } finally {
        Reflect.deleteProperty(editor.view, 'composing');
      }
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Exclusion contexts
// ---------------------------------------------------------------------------

describe('typed autolink — exclusions', () => {
  test('a boundary inside inline code does not convert', async () => {
    const editor = makeLightEditor({ content: '<p><code>https://example.com</code></p>' });
    try {
      insertLocal(editor, ' ', 20);
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  test('a boundary inside a code block does not convert', async () => {
    const editor = makeLightEditor({ content: '<pre>https://example.com</pre>' });
    try {
      insertLocal(editor, ' ', 20);
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  test('a boundary at the end of an existing link leaves that link untouched', async () => {
    const editor = makeLightEditor({
      content: '<p><a href="https://example.com">https://example.com</a></p>',
    });
    try {
      // Seeded links default to linkStyle 'inline'; a re-conversion would flip
      // it to 'gfm-autolink'.
      expect(firstLinkAttrs(editor)?.linkStyle).toBe('inline');
      insertLocal(editor, ' ', 20);
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)?.linkStyle).toBe('inline');
    } finally {
      editor.destroy();
    }
  });

  test('a wikilink atom next to a typed URL never converts and stays intact', async () => {
    // The wikiLink node is an atom: `textBetween` renders it as leaf text, so
    // the word scan can never see inside it. This pins that structural
    // property — if WikiLink ever stops being an atom, this fails instead of
    // the plugin silently starting to linkify wikilink internals.
    const { WikiLink } = await import('@inkeep/open-knowledge-core');
    const editor = mountLightEditor({
      extensions: [WikiLink, GfmAutolink.configure({ isActiveEditor: () => true })],
    });
    try {
      editor.commands.insertContent({ type: 'wikiLink', attrs: { target: 'Some Page' } });
      // Type a URL + boundary right after the atom: only the URL converts.
      const end = editor.state.doc.content.size - 1;
      insertLocal(editor, ' https://after-atom.com ', end);
      await flushMicrotasksAndTimers();
      expect(linkHrefs(editor)).toEqual(['https://after-atom.com']);
      // The atom's target never became link-marked text.
      let wikiTargets = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'wikiLink') wikiTargets++;
        return true;
      });
      expect(wikiTargets).toBe(1);
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Deferred separate dispatch + position re-validation
// ---------------------------------------------------------------------------

describe('typed autolink — deferred dispatch', () => {
  test('the conversion aborts silently when the range changed before the flush', async () => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, 'https://example.com ', 1);
      // Before the queued microtask runs, delete the text the candidate targeted.
      editor.view.dispatch(editor.state.tr.delete(1, editor.state.doc.content.size));
      await flushMicrotasksAndTimers();

      expect(firstLinkAttrs(editor)).toBeNull();
      expect(editor.state.doc.textContent).toBe('');
    } finally {
      editor.destroy();
    }
  });

  test('the mark is added by a later dispatch, not merged into the typing tr', async () => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, 'https://example.com ', 1);
      // Synchronously — before the microtask — the mark is NOT present yet.
      expect(firstLinkAttrs(editor)).toBeNull();
      await flushMicrotasksAndTimers();
      // It arrives on the deferred dispatch.
      expect(firstLinkAttrs(editor)?.linkStyle).toBe('gfm-autolink');
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Undo isolation: the conversion is its own single-Cmd+Z step
// ---------------------------------------------------------------------------

describe('typed autolink — undo isolation (real y-undo binding)', () => {
  test('one undo removes only the link mark, keeping the text and trailing space', async () => {
    const ydoc = new Y.Doc();
    seedFragmentParagraph(ydoc, 'seed');
    const editor = makeCollabEditor(ydoc);
    try {
      await flushMicrotasksAndTimers();
      // Close any binding-init capture so the typing below deterministically
      // starts its own stack item (real typing happens long after doc open).
      readUndoManager(editor)?.stopCapturing();

      insertLocal(editor, ' https://example.com ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkHref(editor)).toBe('https://example.com');

      editor.commands.undo();
      // The mark is gone but the typed text — trailing space included — stays.
      expect(firstLinkAttrs(editor)).toBeNull();
      expect(editor.state.doc.textContent).toBe('seed https://example.com ');

      // The typing itself is the next distinct undo step.
      editor.commands.undo();
      expect(editor.state.doc.textContent).toBe('seed');
    } finally {
      editor.destroy();
      ydoc.destroy();
    }
  });

  test('redo after undoing a conversion re-applies the mark cleanly', async () => {
    const ydoc = new Y.Doc();
    seedFragmentParagraph(ydoc, 'seed');
    const editor = makeCollabEditor(ydoc);
    try {
      await flushMicrotasksAndTimers();
      readUndoManager(editor)?.stopCapturing();

      insertLocal(editor, ' https://example.com ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkHref(editor)).toBe('https://example.com');

      editor.commands.undo();
      expect(firstLinkAttrs(editor)).toBeNull();

      editor.commands.redo();
      const attrs = firstLinkAttrs(editor);
      expect(attrs?.href).toBe('https://example.com');
      expect(attrs?.linkStyle).toBe('gfm-autolink');
      expect(editor.state.doc.textContent).toBe('seed https://example.com ');
    } finally {
      editor.destroy();
      ydoc.destroy();
    }
  });

  test("typing right after a conversion never merges into the mark's undo step", async () => {
    const ydoc = new Y.Doc();
    seedFragmentParagraph(ydoc, 'seed');
    const editor = makeCollabEditor(ydoc);
    try {
      await flushMicrotasksAndTimers();
      readUndoManager(editor)?.stopCapturing();

      insertLocal(editor, ' https://example.com ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkHref(editor)).toBe('https://example.com');

      // Keep typing within the capture window of the mark dispatch.
      insertLocal(editor, 'abc', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();

      editor.commands.undo();
      // Only the new typing reverts; the conversion survives.
      expect(editor.state.doc.textContent).toBe('seed https://example.com ');
      expect(firstLinkHref(editor)).toBe('https://example.com');
    } finally {
      editor.destroy();
      ydoc.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Real y-sync binding: origin guard against a genuine remote transaction
// ---------------------------------------------------------------------------

describe('typed autolink — real CRDT binding', () => {
  test('a remote y-sync edit is not linkified, but a local edit in the same binding is', async () => {
    const ydoc = new Y.Doc();
    // Seed a paragraph with text so the remote append has an XmlText to grow.
    seedFragmentParagraph(ydoc, 'seed');
    const editor = makeCollabEditor(ydoc);

    try {
      await flushMicrotasksAndTimers();

      // A peer appends a URL + space through the real y-sync path. The applied
      // transaction carries ySyncPluginKey meta → origin guard skips it.
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
      remote.transact(() => {
        appendToFirstParagraph(remote.getXmlFragment('default'), ' https://remote.example ');
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(ydoc)), remote);
      remote.destroy();
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toContain('https://remote.example');
      expect(linkHrefs(editor)).not.toContain('https://remote.example');

      // A local edit in the SAME binding still converts.
      const end = editor.state.doc.content.size - 1;
      insertLocal(editor, ' https://local.example ', end);
      await flushMicrotasksAndTimers();

      expect(linkHrefs(editor)).toContain('https://local.example');
      // And the remote URL is still plain text.
      expect(linkHrefs(editor)).not.toContain('https://remote.example');
    } finally {
      editor.destroy();
      ydoc.destroy();
    }
  });
});
