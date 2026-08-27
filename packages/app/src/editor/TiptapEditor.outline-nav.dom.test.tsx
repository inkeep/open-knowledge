// @vitest-environment jsdom
/**
 * The WYSIWYG outline seam, end to end.
 *
 * An outline row click is an explicit navigation: it reaches the editor as the
 * panel's own custom event, resolves the Nth heading in the ProseMirror DOM, and
 * scrolls it into view. What makes it correct is not the scroll — it is that the
 * scroll goes through the coordination producer, which is what makes the
 * document's other scroll writers stand down for it. Two of them exist, and a
 * click that only pre-empts one is erased by the other whenever the clicked
 * heading is ABOVE where the reader currently is.
 *
 * So these cases assert the seam reaches the guarantee, through the predicate
 * the container's restore loop actually reads. That the predicate then stops the
 * real loop is pinned next door, in scroll-navigation-ownership.dom.test.tsx —
 * together the two cover the click all the way to the loop stepping aside.
 *
 * The editor construction path (cache + mount promise) is replaced by a real
 * TipTap editor built here, so the component's own effects run unchanged against
 * a genuine ProseMirror view; the surrounding chrome is stubbed to markers. That
 * is the same harness the deep-link ladder test uses.
 */

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
/** The diagnostic mark that makes a refused navigation attributable. */
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

// jsdom ships no `CSS` object; the deep-link ladder escapes an anchor before
// querying for it, and it runs on mount here too.
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

    // jsdom implements neither scroll nor layout, so the seam's only observable
    // act is this call, and which element it landed on.
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
    // The editor arrives through a suspended promise, so the commit that runs
    // the effects happens after it resolves — inside this awaited act scope.
    await act(async () => {
      render(tree());
    });
  }

  /** What the outline panel emits when a row is clicked. */
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

    // Sampled inside the scroll stub rather than read back here, because the
    // guarantee is that the flag was up AT the moment the click scrolled — the
    // hold self-releases on a timer, so a later read measures how long the
    // assertion took to arrive as much as it measures the seam. This is the
    // predicate the container's restore loop polls every frame; a click that
    // scrolls without setting it is re-applied over whenever the heading sits
    // above the reader, because the loop's takeover test only recognises a
    // scrollTop increase.
    expect(suppressedAtScroll).toEqual([true]);
  });

  test('a refused click is recorded rather than silently doing nothing', async () => {
    await renderEditor();
    // A landing that is itself an explicit navigation does not yield the
    // scroller, so the click is declined and nothing moves.
    registerLandingScrollOwner(DOC_NAME, { yieldsToNavigation: false, supersede: () => {} });

    await clickOutlineRow(1, 'middle');

    expect(scrolled).toEqual([]);
    // The outline seam treats the producer as an action and drops its answer, so
    // a refusal is invisible from here: the row highlights and the view does not
    // move. The refusal has to be attributable somewhere, and to THIS seam —
    // other seams consume the answer and retry, so the same mark means a dead
    // click here and a late one there.
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

    // Pooled siblings all hold this listener; claiming a scroller on someone
    // else's behalf would stand down a restore that has nothing to do with the
    // click.
    expect(scrolled).toEqual([]);
    expect(isScrollRestoreSuppressed('some-other-doc')).toBe(false);
    expect(isScrollRestoreSuppressed(DOC_NAME)).toBe(false);
  });
});
