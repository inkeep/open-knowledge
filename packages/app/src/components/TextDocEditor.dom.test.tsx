import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { FULL_PAGE_CM_HOST_SELECTORS } from '@/editor/document-scrollports';
import {
  getFullPageCmEntryForDoc,
  getMarkdownSourceViewForDoc,
  unregisterFullPageCmView,
} from '@/editor/full-page-cm-views';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

const { TextDocEditor } = await import('./TextDocEditor');

const DOC_NAME = 'notes/scratch.txt';

const HOST_SELECTOR = FULL_PAGE_CM_HOST_SELECTORS.textDocEditor;

function mountTextDocEditor(): {
  container: HTMLElement;
  unmount: () => void;
  dispose: () => void;
} {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  const provider = {
    document,
    awareness,
    on() {},
    off() {},
  } as unknown as HocuspocusProvider;
  const { container, unmount } = render(<TextDocEditor docName={DOC_NAME} provider={provider} />);
  return {
    container,
    unmount,
    dispose: () => {
      awareness.destroy();
      document.destroy();
    },
  };
}

afterEach(() => {
  cleanup();
  const entry = getFullPageCmEntryForDoc(DOC_NAME);
  if (entry) unregisterFullPageCmView(DOC_NAME, entry.view);
});

describe('TextDocEditor host contract', () => {
  test('renders the host attribute used by the composer-inset selector', () => {
    const { container, unmount, dispose } = mountTextDocEditor();

    expect(container.querySelector(HOST_SELECTOR)).not.toBeNull();

    unmount();
    dispose();
  });

  test('registers its CodeMirror under the textDocEditor host while it is mounted', () => {
    const { container, unmount, dispose } = mountTextDocEditor();

    const entry = getFullPageCmEntryForDoc(DOC_NAME);

    expect(
      entry,
      'an editable text doc that registers nothing is unreachable from the composer caret reveal, ' +
        'so opening the composer over a mid-document caret buries it',
    ).not.toBeNull();
    expect(entry?.host).toBe('textDocEditor');
    expect(
      entry?.view.scrollDOM,
      'the registered view must be the CodeMirror this component mounted, and its scrollDOM must ' +
        'be the element the textDocEditor scrollport selector matches',
    ).toBe(container.querySelector(`${HOST_SELECTOR} .cm-scroller`));

    unmount();
    dispose();
  });

  test('leaves the markdown source-editor accessor empty', () => {
    const { unmount, dispose } = mountTextDocEditor();

    expect(
      getMarkdownSourceViewForDoc(DOC_NAME),
      'a text doc CodeMirror holds no markdown, so the markdown outline and landing resolvers must ' +
        'not find it here',
    ).toBeNull();

    unmount();
    dispose();
  });

  test('unregisters its CodeMirror when it unmounts', () => {
    const { unmount, dispose } = mountTextDocEditor();
    expect(getFullPageCmEntryForDoc(DOC_NAME)).not.toBeNull();

    unmount();

    expect(
      getFullPageCmEntryForDoc(DOC_NAME),
      'a registration that outlives its view leaves the reveal scrolling a destroyed CodeMirror',
    ).toBeNull();

    dispose();
  });
});
