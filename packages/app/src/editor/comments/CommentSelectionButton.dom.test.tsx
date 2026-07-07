import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  getDocumentCommentSnapshot,
  resetDocumentCommentsForTests,
} from '@/editor/comments/comment-store';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const requestedTabs: string[] = [];
mock.module('@/components/doc-panel-events', () => ({
  requestDocPanelTab: (tab: string) => requestedTabs.push(tab),
}));

mock.module('@/editor/edit-with-ai-selection', () => ({
  serializeWysiwygSelection: () => '**selected text**',
}));

const { CommentSelectionButton } = await import('./CommentSelectionButton');

type Handler = () => void;

function fakeEditor() {
  const editorDom = document.createElement('div');
  document.body.append(editorDom);
  const handlers = new Map<string, Handler>();
  const content = 'Intro selected text outro';
  return {
    editorDom,
    editor: {
      state: {
        selection: { from: 6, to: 19, empty: false },
        doc: {
          textBetween(from: number, to: number) {
            return content.slice(from, to);
          },
        },
      },
      view: { dom: editorDom },
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      off(event: string) {
        handlers.delete(event);
      },
    },
    fireSelectionUpdate() {
      handlers.get('selectionUpdate')?.();
    },
    cleanup() {
      editorDom.remove();
    },
  };
}

beforeEach(() => {
  requestedTabs.length = 0;
  resetDocumentCommentsForTests();
});

afterEach(() => {
  cleanup();
  resetDocumentCommentsForTests();
  mock.restore();
});

describe('CommentSelectionButton', () => {
  test('captures the active WYSIWYG selection as a pending document comment', async () => {
    const originalSelection = window.getSelection;
    const { editor, editorDom, fireSelectionUpdate, cleanup: cleanupEditor } = fakeEditor();
    window.getSelection = () =>
      ({
        rangeCount: 1,
        getRangeAt: () =>
          ({
            commonAncestorContainer: editorDom,
            getClientRects: () => [{ width: 80, height: 20, top: 40, left: 24 }],
            getBoundingClientRect: () => ({ width: 80, height: 20, top: 40, left: 24 }),
          }) as unknown as Range,
      }) as unknown as Selection;

    try {
      render(
        <CommentSelectionButton
          editor={editor as never}
          docName="notes"
          activeDocName="notes"
          isSourceMode={false}
        />,
      );

      act(() => fireSelectionUpdate());
      fireEvent.mouseDown(await screen.findByTestId('comment-selection-button'));

      const snapshot = getDocumentCommentSnapshot('notes');
      expect(snapshot.pending).toMatchObject({
        docName: 'notes',
        textStart: 6,
        textEnd: 19,
        anchorText: 'selected text',
        markdown: '**selected text**',
        charLen: '**selected text**'.length,
        lineCount: 1,
      });
      expect(requestedTabs).toEqual(['comments']);
    } finally {
      window.getSelection = originalSelection;
      cleanupEditor();
    }
  });
});
