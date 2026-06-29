
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import type * as Y from 'yjs';
import { buildPatternDConstructorOptions } from './TiptapEditor';
import {
  applyRemoteEdit,
  buildSeededPatternDProvider,
  dispatchSelectionOnly,
  fakeClipboard,
  flushMicrotasksAndTimers,
  insertParagraphAt,
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


interface MountedPatternDHarness {
  editor: Editor;
  ydoc: Y.Doc;
  fragment: Y.XmlFragment;
  cleanup: () => void;
}

async function mountPatternDEditor(
  seed: (ydoc: Y.Doc) => void = (ydoc) => seedFragmentParagraph(ydoc, 'hello world'),
): Promise<MountedPatternDHarness> {
  const {
    ydoc,
    fragment,
    provider,
    cleanup: providerCleanup,
  } = buildSeededPatternDProvider('schema-identity', seed);

  const options = buildPatternDConstructorOptions({
    provider,
    clipboard: fakeClipboard,
    ctorStart: performance.now(),
  });
  const editor = new Editor(options);
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  await flushMicrotasksAndTimers();

  const cleanup = () => {
    editor.destroy();
    host.remove();
    providerCleanup();
  };
  return { editor, ydoc, fragment, cleanup };
}


describe('Pattern D schema-instance identity (post-mount incremental updates)', () => {
  test('an unchanged sibling paragraph survives a post-mount remote paragraph insert', async () => {
    const harness = await mountPatternDEditor();
    try {
      applyRemoteEdit(harness.ydoc, (frag) => insertParagraphAt(frag, 1, 'second paragraph'));
      await flushMicrotasksAndTimers();

      const pmText = harness.editor.state.doc.textContent;
      expect(pmText).toContain('second paragraph');
      expect(pmText).toContain('hello world');

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('second paragraph');
      expect(yXml).toContain('hello world');
    } finally {
      harness.cleanup();
    }
  });

  test('the first post-update user transaction does not erase the unchanged paragraph from the CRDT', async () => {
    const harness = await mountPatternDEditor();
    try {
      applyRemoteEdit(harness.ydoc, (frag) => insertParagraphAt(frag, 1, 'second paragraph'));
      await flushMicrotasksAndTimers();

      dispatchSelectionOnly(harness.editor);
      await flushMicrotasksAndTimers();

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('hello world');
      expect(yXml).toContain('second paragraph');
      const pmText = harness.editor.state.doc.textContent;
      expect(pmText).toContain('hello world');
      expect(pmText).toContain('second paragraph');
    } finally {
      harness.cleanup();
    }
  });

  test('an unchanged paragraph survives a post-mount remote text edit inside a DIFFERENT walked paragraph', async () => {
    const harness = await mountPatternDEditor((ydoc) => {
      seedFragmentParagraph(ydoc, 'hello world');
      insertParagraphAt(ydoc.getXmlFragment('default'), 1, 'closing notes');
    });
    try {
      applyRemoteEdit(harness.ydoc, (frag) => {
        const second = frag.get(1) as Y.XmlElement;
        const text = second.get(0) as Y.XmlText;
        text.insert(text.length, ' EDITED');
      });
      await flushMicrotasksAndTimers();

      const pmText = harness.editor.state.doc.textContent;
      expect(pmText).toContain('closing notes EDITED');
      expect(pmText).toContain('hello world');

      dispatchSelectionOnly(harness.editor);
      await flushMicrotasksAndTimers();

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('hello world');
      expect(yXml).toContain('closing notes EDITED');
    } finally {
      harness.cleanup();
    }
  });

  test('an unchanged sibling paragraph survives a post-mount remote prepend insert', async () => {
    const harness = await mountPatternDEditor();
    try {
      applyRemoteEdit(harness.ydoc, (frag) => insertParagraphAt(frag, 0, 'prepended paragraph'));
      await flushMicrotasksAndTimers();

      const pmText = harness.editor.state.doc.textContent;
      expect(pmText).toContain('prepended paragraph');
      expect(pmText).toContain('hello world');

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('prepended paragraph');
      expect(yXml).toContain('hello world');
    } finally {
      harness.cleanup();
    }
  });

  test('repeated incremental remote inserts never drop the original paragraph', async () => {
    const harness = await mountPatternDEditor();
    try {
      for (let i = 1; i <= 3; i += 1) {
        applyRemoteEdit(harness.ydoc, (frag) =>
          insertParagraphAt(frag, frag.length, `update ${i}`),
        );
        await flushMicrotasksAndTimers();
        expect(harness.editor.state.doc.textContent).toContain('hello world');
        expect(harness.editor.state.doc.textContent).toContain(`update ${i}`);
      }

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('hello world');
      for (let i = 1; i <= 3; i += 1) {
        expect(yXml).toContain(`update ${i}`);
      }
      dispatchSelectionOnly(harness.editor);
      await flushMicrotasksAndTimers();
      const postClickYXml = harness.fragment.toString();
      expect(postClickYXml).toContain('hello world');
      for (let i = 1; i <= 3; i += 1) {
        expect(postClickYXml).toContain(`update ${i}`);
      }
    } finally {
      harness.cleanup();
    }
  });
});
