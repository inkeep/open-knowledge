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

vi.doMock('@/editor/components/Mermaid', () => ({
  MermaidView: () => <div data-testid="mermaid-view" />,
}));

const { MermaidDocEditor } = await import('./MermaidDocEditor');

const DOC_NAME = 'diagram.mmd';

const HOST_SELECTOR = FULL_PAGE_CM_HOST_SELECTORS.mermaidDocEditor;

function mountMermaidDocEditor(isSourceMode: boolean): {
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
  const { container, unmount } = render(
    <MermaidDocEditor docName={DOC_NAME} provider={provider} isSourceMode={isSourceMode} />,
  );
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

describe('MermaidDocEditor host contract', () => {
  test('renders the host attribute used by the composer-inset selector', () => {
    const { container, unmount, dispose } = mountMermaidDocEditor(false);

    expect(container.querySelector(HOST_SELECTOR)).not.toBeNull();

    unmount();
    dispose();
  });

  test('registers its source pane CodeMirror under the mermaidDocEditor host in source mode', () => {
    const { container, unmount, dispose } = mountMermaidDocEditor(true);

    const entry = getFullPageCmEntryForDoc(DOC_NAME);

    expect(
      entry,
      'a mermaid doc in source mode that registers nothing is unreachable from the composer caret ' +
        'reveal, so opening the composer over a mid-document caret buries it',
    ).not.toBeNull();
    expect(entry?.host).toBe('mermaidDocEditor');
    expect(
      entry?.view.scrollDOM,
      'the registered view must be the CodeMirror the source pane mounted, and its scrollDOM must ' +
        'be the element the mermaidDocEditor scrollport selector matches',
    ).toBe(container.querySelector(`${HOST_SELECTOR} .cm-scroller`));

    unmount();
    dispose();
  });

  test('leaves the markdown source-editor accessor empty in source mode', () => {
    const { unmount, dispose } = mountMermaidDocEditor(true);

    expect(
      getMarkdownSourceViewForDoc(DOC_NAME),
      'a mermaid source pane holds no markdown, so the markdown outline and landing resolvers must ' +
        'not find it here',
    ).toBeNull();

    unmount();
    dispose();
  });

  test('registers nothing in diagram mode, where there is no caret to reveal', () => {
    const { unmount, dispose } = mountMermaidDocEditor(false);

    expect(getFullPageCmEntryForDoc(DOC_NAME)).toBeNull();

    unmount();
    dispose();
  });

  test('unregisters its source pane CodeMirror when it unmounts', () => {
    const { unmount, dispose } = mountMermaidDocEditor(true);
    expect(getFullPageCmEntryForDoc(DOC_NAME)).not.toBeNull();

    unmount();

    expect(
      getFullPageCmEntryForDoc(DOC_NAME),
      'a registration that outlives its view leaves the reveal scrolling a destroyed CodeMirror',
    ).toBeNull();

    dispose();
  });
});
