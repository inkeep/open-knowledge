// @vitest-environment jsdom

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, render } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { sharedExtensions } from './extensions/shared';

const DOC_NAME = 'hash-ladder-doc';

let editorEntry: {
  editor: Editor;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
} | null = null;

vi.doMock('./DocumentContext', () => ({
  useDocumentContext: () => ({
    principal: null,
    activeDocName: DOC_NAME,
    recycleDocument: () => {},
    openTarget: () => {},
  }),
}));
vi.doMock('../presence/identity', () => ({
  useIdentity: () => ({ name: 'Tester', color: '#336699' }),
}));
vi.doMock('./mount-promise', () => ({
  mountTiptapEditorPromise: () => Promise.resolve(editorEntry),
}));
vi.doMock('./editor-cache', () => ({
  parkTiptapEditor: () => {},
  peekRenameSnapshot: () => null,
  clearRenameSnapshot: () => {},
}));
vi.doMock('./bubble-menu/BubbleMenuBar', () => ({ BubbleMenuBar: () => <div /> }));
vi.doMock('./table-controls/TableCellHandles', () => ({ TableCellHandles: () => <div /> }));
vi.doMock('@/components/editor/SelectionAnnouncer', () => ({
  SelectionAnnouncer: () => <div />,
}));
vi.doMock('./interaction-layer', () => ({ InteractionLayerView: () => <div /> }));
vi.doMock('@tiptap/react', () => ({ EditorContent: () => <div data-testid="editor-content" /> }));

const { TiptapEditor } = await import('./TiptapEditor');

if (typeof globalThis.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
    configurable: true,
  });
}

function makeProvider(ydoc: Y.Doc): HocuspocusProvider {
  return {
    document: ydoc,
    awareness: new Awareness(ydoc),
    configuration: { name: DOC_NAME },
    on: () => {},
    off: () => {},
  } as unknown as HocuspocusProvider;
}

describe('TiptapEditor deep-link hash ladder', () => {
  let host: HTMLElement;
  let portalTarget: HTMLElement;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: PropertyDescriptor | undefined;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    portalTarget = document.createElement('div');
    document.body.appendChild(portalTarget);

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('source');
    ytext.insert(0, '# Target Heading\n\nbody');
    const editor = new Editor({
      element: host,
      extensions: sharedExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Target Heading' }],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
        ],
      },
    });
    editorEntry = { editor, ydoc, ytext, provider: makeProvider(ydoc) };

    scrollIntoView = vi.fn();
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    window.location.hash = `#/${DOC_NAME}#target-heading`;
  });

  afterEach(() => {
    cleanup();
    editorEntry?.editor.destroy();
    editorEntry = null;
    host.remove();
    portalTarget.remove();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
    window.location.hash = '';
  });

  function tree(isSourceMode: boolean) {
    const entry = editorEntry;
    if (!entry) throw new Error('editor entry not prepared');
    return (
      <Suspense fallback={null}>
        <TiptapEditor
          provider={entry.provider}
          isSourceMode={isSourceMode}
          portalTarget={portalTarget}
        />
      </Suspense>
    );
  }

  async function renderEditor(
    isSourceMode: boolean,
  ): Promise<ReturnType<typeof render> | undefined> {
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(tree(isSourceMode));
    });
    return result;
  }

  test('anchor id is present so the ladder has a target to find', () => {
    expect(editorEntry?.editor.view.dom.querySelector('#target-heading')).not.toBeNull();
  });

  test('scrolls the hash anchor into view in visual mode', async () => {
    await renderEditor(false);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  test('does not run the ladder while source mode is active', async () => {
    await renderEditor(true);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  test('picks the hash up on the flip back out of source mode', async () => {
    const result = await renderEditor(true);
    expect(scrollIntoView).not.toHaveBeenCalled();

    await act(async () => {
      result?.rerender(tree(false));
    });

    expect(scrollIntoView).toHaveBeenCalled();
  });
});
