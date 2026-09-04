// @vitest-environment jsdom

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, render } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { sharedExtensions } from './extensions/shared';
import {
  clearPendingWysiwygNavigationsForTest,
  peekPendingWysiwygNavigation,
  rememberPendingWysiwygNavigation,
} from './source-editor-navigation';

const DOC_NAME = 'replay-create-retry-doc';

let editorEntry: {
  editor: Editor;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
} | null = null;

let viewReady = false;

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
  visibleEditorScrollContainer: () => null,
}));
vi.doMock('./bubble-menu/BubbleMenuBar', () => ({ BubbleMenuBar: () => <div /> }));
vi.doMock('./table-controls/TableCellHandles', () => ({ TableCellHandles: () => <div /> }));
vi.doMock('@/components/editor/SelectionAnnouncer', () => ({
  SelectionAnnouncer: () => <div />,
}));
vi.doMock('./interaction-layer', () => ({ InteractionLayerView: () => <div /> }));
vi.doMock('@tiptap/react', () => ({ EditorContent: () => <div data-testid="editor-content" /> }));
vi.doMock('./utils/get-editor-view', () => ({
  getEditorView: (editor: Editor) =>
    viewReady ? (editor as unknown as { editorView?: unknown }).editorView : undefined,
}));

const { TiptapEditor } = await import('./TiptapEditor');

function makeProvider(ydoc: Y.Doc): HocuspocusProvider {
  return {
    document: ydoc,
    awareness: new Awareness(ydoc),
    configuration: { name: DOC_NAME },
    on: () => {},
    off: () => {},
  } as unknown as HocuspocusProvider;
}

describe('TiptapEditor source-to-WYSIWYG replay create retry', () => {
  let host: HTMLElement;
  let portalTarget: HTMLElement;

  beforeEach(() => {
    clearPendingWysiwygNavigationsForTest();
    viewReady = false;
    host = document.createElement('div');
    document.body.appendChild(host);
    portalTarget = document.createElement('div');
    document.body.appendChild(portalTarget);

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('source');
    ytext.insert(0, '# Title\n\nbody');
    const editor = new Editor({
      element: host,
      extensions: sharedExtensions,
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
        ],
      },
    });
    editorEntry = { editor, ydoc, ytext, provider: makeProvider(ydoc) };
  });

  afterEach(() => {
    cleanup();
    editorEntry?.editor.destroy();
    editorEntry = null;
    clearPendingWysiwygNavigationsForTest();
    host.remove();
    portalTarget.remove();
  });

  async function renderVisual(): Promise<void> {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <TiptapEditor
            provider={editorEntry?.provider as HocuspocusProvider}
            isSourceMode={false}
            portalTarget={portalTarget}
          />
        </Suspense>,
      );
    });
  }

  test('consumes a queued landing only once the view finishes mounting', async () => {
    rememberPendingWysiwygNavigation(DOC_NAME, {
      kind: 'selection-offset',
      anchor: { blockIndex: 1, kind: 'paragraph', content: 'body' },
    });

    await renderVisual();
    expect(peekPendingWysiwygNavigation(DOC_NAME)).not.toBeNull();

    await act(async () => {
      viewReady = true;
      editorEntry?.editor.emit('create', { editor: editorEntry.editor });
      await Promise.resolve();
    });

    expect(peekPendingWysiwygNavigation(DOC_NAME)).toBeNull();
  });
});
