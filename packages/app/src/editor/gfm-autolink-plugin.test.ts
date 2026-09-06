import type { Editor } from '@tiptap/core';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  firstLinkAttrs,
  firstLinkHref,
  insertLocal,
  linkHrefs,
  mountAppEditor,
  mountLightEditor,
  mountProjectionEditor,
  type ProjectionEditorRig,
} from './editor-rig.test-helper';
import { GfmAutolink, PREVENT_AUTOLINK_META } from './gfm-autolink-plugin';
import { flushMicrotasksAndTimers, installDomGlobals } from './walk-currency-test-harness';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

function makeLightEditor(opts: { content?: string; isActiveEditor?: () => boolean } = {}): Editor {
  return mountLightEditor({
    content: opts.content,
    extensions: [GfmAutolink.configure({ isActiveEditor: opts.isActiveEditor ?? (() => true) })],
  });
}

function makeProjectionEditor(source: string): ProjectionEditorRig {
  return mountProjectionEditor(source, [GfmAutolink.configure({ isActiveEditor: () => true })]);
}

describe('typed autolink — conversion', () => {
  test('typing a URL then a space converts it to a gfm-autolink link mark', async () => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, 'https://example.com ', 1);
      await flushMicrotasksAndTimers();

      const attrs = firstLinkAttrs(editor);
      expect(attrs?.href).toBe('https://example.com');
      expect(attrs?.linkStyle).toBe('gfm-autolink');
      expect(editor.state.doc.textContent).toBe('https://example.com ');
    } finally {
      editor.destroy();
    }
  });

  test('pressing Enter after a URL converts the trailing token', async () => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, 'https://example.com', 1);
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

describe('typed autolink — guards', () => {
  test('a transaction tagged with ySyncPluginKey meta never converts', async () => {
    const editor = makeLightEditor();
    try {
      const tr = editor.state.tr.insertText('https://example.com ', 1, 1);
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
      expect(firstLinkAttrs(editor)?.linkStyle).toBe('inline');
      insertLocal(editor, ' ', 20);
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)?.linkStyle).toBe('inline');
    } finally {
      editor.destroy();
    }
  });

  test('a wikilink atom next to a typed URL never converts and stays intact', async () => {
    const { WikiLink } = await import('@inkeep/open-knowledge-core');
    const editor = mountLightEditor({
      extensions: [WikiLink, GfmAutolink.configure({ isActiveEditor: () => true })],
    });
    try {
      editor.commands.insertContent({ type: 'wikiLink', attrs: { target: 'Some Page' } });
      const end = editor.state.doc.content.size - 1;
      insertLocal(editor, ' https://after-atom.com ', end);
      await flushMicrotasksAndTimers();
      expect(linkHrefs(editor)).toEqual(['https://after-atom.com']);
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

describe('typed autolink — deferred dispatch', () => {
  test('the conversion aborts silently when the range changed before the flush', async () => {
    const editor = makeLightEditor();
    try {
      insertLocal(editor, 'https://example.com ', 1);
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
      expect(firstLinkAttrs(editor)).toBeNull();
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)?.linkStyle).toBe('gfm-autolink');
    } finally {
      editor.destroy();
    }
  });
});

describe('typed autolink — undo under the projection binding', () => {
  test('one undo retracts the typed run; the derived mark goes with it', async () => {
    const rig = makeProjectionEditor('seed\n');
    const { editor } = rig;
    try {
      await flushMicrotasksAndTimers();
      rig.undoManager.stopCapturing();

      insertLocal(editor, ' https://example.com ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkHref(editor)).toBe('https://example.com');

      rig.undoManager.undo();
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)).toBeNull();
      expect(editor.state.doc.textContent).toBe('seed');
      expect(rig.ytext.toString()).toBe('seed\n');
    } finally {
      rig.destroy();
    }
  });

  test('redo after undoing a typed autolink restores the text and re-derives the mark', async () => {
    const rig = makeProjectionEditor('seed\n');
    const { editor } = rig;
    try {
      await flushMicrotasksAndTimers();
      rig.undoManager.stopCapturing();

      insertLocal(editor, ' https://example.com ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkHref(editor)).toBe('https://example.com');

      rig.undoManager.undo();
      await flushMicrotasksAndTimers();
      expect(firstLinkAttrs(editor)).toBeNull();

      rig.undoManager.redo();
      await flushMicrotasksAndTimers();
      expect(editor.state.doc.textContent).toBe('seed https://example.com');
      const attrs = firstLinkAttrs(editor);
      expect(attrs?.href).toBe('https://example.com');
      expect(attrs?.linkStyle).toBe('gfm-autolink');
    } finally {
      rig.destroy();
    }
  });

  test('an autolink conversion writes no bytes of its own', async () => {
    const rig = makeProjectionEditor('seed\n');
    const { editor } = rig;
    try {
      await flushMicrotasksAndTimers();
      rig.undoManager.stopCapturing();

      insertLocal(editor, ' https://example.com ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();
      expect(firstLinkHref(editor)).toBe('https://example.com');
      expect(rig.ytext.toString()).toBe('seed https://example.com\n');
    } finally {
      rig.destroy();
    }
  });
});

describe('typed autolink — real CRDT binding', () => {
  test('a URL typed after a remote edit autolinks like any other', async () => {
    const rig = makeProjectionEditor('seed\n');
    const { editor } = rig;

    try {
      await flushMicrotasksAndTimers();

      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(rig.ydoc));
      remote.transact(() => {
        const remoteText = remote.getText('source');
        remoteText.insert(remoteText.toString().indexOf('\n'), ' plain remote words ');
      });
      const remoteBytes = remote.getText('source').toString();
      Y.applyUpdate(rig.ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(rig.ydoc)), remote);
      remote.destroy();
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toContain('plain remote words');
      expect(rig.ytext.toString()).toBe(remoteBytes);

      insertLocal(editor, ' https://local.example ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();

      expect(linkHrefs(editor)).toContain('https://local.example');
      expect(rig.ytext.toString()).toContain('https://local.example');
    } finally {
      rig.destroy();
    }
  });

  test('CHARACTERIZATION: a URL typed onto the end of a link joins that link instead of getting its own', async () => {
    const rig = makeProjectionEditor('seed https://seeded.example\n');
    const { editor } = rig;

    try {
      await flushMicrotasksAndTimers();
      expect(linkHrefs(editor)).toEqual(['https://seeded.example']);

      insertLocal(editor, ' https://local.example ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toContain('https://local.example');
      expect(linkHrefs(editor)).not.toContain('https://local.example');
      expect(linkHrefs(editor)).toEqual(['https://seeded.example']);
      expect(rig.ytext.toString()).toContain('https://local.example');
    } finally {
      rig.destroy();
    }
  });
});

describe('typed autolink — the same characterization with no CRDT layer at all', () => {
  test('CHARACTERIZATION: the link mark is inclusive, so typing at its end extends it', async () => {
    const editor = mountAppEditor();

    try {
      expect(editor.state.schema.marks.link?.spec.inclusive).toBe(true);

      insertLocal(editor, 'seed https://first.example ', 1);
      await flushMicrotasksAndTimers();
      expect(linkHrefs(editor)).toEqual(['https://first.example']);

      const size = editor.state.doc.content.size;
      editor.view.dispatch(editor.state.tr.delete(size - 2, size - 1));
      await flushMicrotasksAndTimers();

      insertLocal(editor, ' https://second.example ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();

      expect(editor.state.doc.textContent).toContain('https://second.example');
      expect(linkHrefs(editor)).toEqual(['https://first.example']);
    } finally {
      editor.destroy();
    }
  });

  test('the same keystrokes against a non-inclusive link mark produce two links', async () => {
    const editor = makeLightEditor();

    try {
      expect(editor.state.schema.marks.link?.spec.inclusive).toBe(false);

      insertLocal(editor, 'seed https://first.example ', 1);
      await flushMicrotasksAndTimers();
      expect(linkHrefs(editor)).toEqual(['https://first.example']);

      const size = editor.state.doc.content.size;
      editor.view.dispatch(editor.state.tr.delete(size - 2, size - 1));
      await flushMicrotasksAndTimers();

      insertLocal(editor, ' https://second.example ', editor.state.doc.content.size - 1);
      await flushMicrotasksAndTimers();

      expect(linkHrefs(editor)).toEqual(['https://first.example', 'https://second.example']);
    } finally {
      editor.destroy();
    }
  });
});
