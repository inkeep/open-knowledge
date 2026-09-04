// @vitest-environment jsdom

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, render } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { OUTLINE_NAV_EVENT, type OutlineNavDetail } from '@/components/OutlinePanel';
import {
  __resetScrollRestoreCoordination,
  isScrollRestoreSuppressed,
  registerLandingScrollOwner,
} from '@/editor/scroll-restore-coordination';
import { getCollector } from '@/lib/perf/collector';
import { sharedExtensions } from './extensions/shared';

const DOC_NAME = 'outline-nav-doc';
const NAVIGATION_DECLINED_MARK = 'ok/scroll-nav/declined';

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
vi.doMock('./editor-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./editor-cache')>()),
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

describe('outline navigation in the WYSIWYG editor', () => {
  let host: HTMLElement;
  let portalTarget: HTMLElement;
  let scrolled: HTMLElement[];
  let suppressedAtScroll: boolean[];
  let originalScrollIntoView: PropertyDescriptor | undefined;

  beforeEach(() => {
    __resetScrollRestoreCoordination();
    getCollector()?.reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    portalTarget = document.createElement('div');
    document.body.appendChild(portalTarget);

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('source');
    ytext.insert(0, '# Top\n\nbody\n\n## Middle\n\nbody\n\n## Bottom\n\nbody');
    const editor = new Editor({
      element: host,
      extensions: sharedExtensions,
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Top' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Middle' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Bottom' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
        ],
      },
    });
    editorEntry = { editor, ydoc, ytext, provider: makeProvider(ydoc) };

    scrolled = [];
    suppressedAtScroll = [];
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: function scrollIntoViewStub(this: HTMLElement) {
        scrolled.push(this);
        suppressedAtScroll.push(isScrollRestoreSuppressed(DOC_NAME));
      },
      configurable: true,
      writable: true,
    });
    window.location.hash = '';
  });

  afterEach(() => {
    cleanup();
    editorEntry?.editor.destroy();
    editorEntry = null;
    host.remove();
    portalTarget.remove();
    __resetScrollRestoreCoordination();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  function tree() {
    const entry = editorEntry;
    if (!entry) throw new Error('editor entry not prepared');
    return (
      <Suspense fallback={null}>
        <TiptapEditor provider={entry.provider} isSourceMode={false} portalTarget={portalTarget} />
      </Suspense>
    );
  }

  async function renderEditor(): Promise<void> {
    await act(async () => {
      render(tree());
    });
  }

  async function clickOutlineRow(index: number, slug: string): Promise<void> {
    const detail: OutlineNavDetail = { docName: DOC_NAME, index, slug, mode: 'wysiwyg' };
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OUTLINE_NAV_EVENT, { detail }));
    });
  }

  function declinedNavigations(): unknown[] {
    return (getCollector()?.marks.toArray() ?? [])
      .filter((m) => m.name === NAVIGATION_DECLINED_MARK)
      .map((m) => m.properties);
  }

  test('scrolls the heading the clicked row names', async () => {
    await renderEditor();

    await clickOutlineRow(1, 'middle');

    expect(scrolled.map((el) => el.textContent)).toEqual(['Middle']);
  });

  test('the click stands the document scroll-restore down while it lands', async () => {
    await renderEditor();

    await clickOutlineRow(1, 'middle');

    expect(suppressedAtScroll).toEqual([true]);
  });

  test('a refused click is recorded rather than silently doing nothing', async () => {
    await renderEditor();
    registerLandingScrollOwner(DOC_NAME, { yieldsToNavigation: false, supersede: () => {} });

    await clickOutlineRow(1, 'middle');

    expect(scrolled).toEqual([]);
    expect(declinedNavigations()).toEqual([
      expect.objectContaining({ docName: DOC_NAME, seam: 'outline' }),
    ]);
  });

  test('a click for another document is ignored', async () => {
    await renderEditor();

    const detail: OutlineNavDetail = {
      docName: 'some-other-doc',
      index: 1,
      slug: 'middle',
      mode: 'wysiwyg',
    };
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OUTLINE_NAV_EVENT, { detail }));
    });

    expect(scrolled).toEqual([]);
    expect(isScrollRestoreSuppressed('some-other-doc')).toBe(false);
    expect(isScrollRestoreSuppressed(DOC_NAME)).toBe(false);
  });
});
