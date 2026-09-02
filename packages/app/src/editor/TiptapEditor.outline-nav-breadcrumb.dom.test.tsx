// @vitest-environment jsdom

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, render } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  OUTLINE_NAV_BREADCRUMB,
  OUTLINE_NAV_EVENT,
  OUTLINE_NAV_SETTLED_BREADCRUMB,
  type OutlineNavDetail,
} from '@/components/OutlinePanel';
import { sharedExtensions } from './extensions/shared';
import {
  __resetScrollRestoreCoordination,
  registerLandingScrollOwner,
} from './scroll-restore-coordination';

const DOC_NAME = 'outline-nav-doc';
const HEADINGS = [
  { text: 'Alpha', level: 1 },
  { text: 'Beta', level: 3 },
  { text: 'Gamma', level: 2 },
] as const;

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
vi.doMock('./utils/get-editor-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/get-editor-view')>();
  return {
    ...actual,
    getEditorView: (editor: Parameters<typeof actual.getEditorView>[0]) =>
      viewUnavailable ? undefined : actual.getEditorView(editor),
  };
});
vi.doMock('./bubble-menu/BubbleMenuBar', () => ({ BubbleMenuBar: () => <div /> }));
vi.doMock('./table-controls/TableCellHandles', () => ({ TableCellHandles: () => <div /> }));
vi.doMock('@/components/editor/SelectionAnnouncer', () => ({
  SelectionAnnouncer: () => <div />,
}));
vi.doMock('./interaction-layer', () => ({ InteractionLayerView: () => <div /> }));
vi.doMock('@tiptap/react', () => ({ EditorContent: () => <div data-testid="editor-content" /> }));

const { TiptapEditor } = await import('./TiptapEditor');

let scroller: HTMLDivElement | null = null;
let viewUnavailable = false;

function makeProvider(ydoc: Y.Doc): HocuspocusProvider {
  return {
    document: ydoc,
    awareness: new Awareness(ydoc),
    configuration: { name: DOC_NAME },
    on: () => {},
    off: () => {},
  } as unknown as HocuspocusProvider;
}

describe('outline click breadcrumb', () => {
  let host: HTMLElement;
  let portalTarget: HTMLElement;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetScrollRestoreCoordination();
    scroller = document.createElement('div');
    scroller.setAttribute('data-testid', 'editor-scroll-container');
    document.body.appendChild(scroller);
    scroller.scrollTop = 250;
    host = document.createElement('div');
    scroller.appendChild(host);
    portalTarget = document.createElement('div');
    document.body.appendChild(portalTarget);

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('source');
    const editor = new Editor({
      element: host,
      extensions: sharedExtensions,
      content: {
        type: 'doc',
        content: HEADINGS.map(({ text, level }) => ({
          type: 'heading',
          attrs: { level },
          content: [{ type: 'text', text }],
        })),
      },
    });
    editorEntry = { editor, ydoc, ytext, provider: makeProvider(ydoc) };

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    editorEntry?.editor.destroy();
    editorEntry = null;
    host.remove();
    portalTarget.remove();
    scroller?.remove();
    scroller = null;
    __resetScrollRestoreCoordination();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  function breadcrumbs(event = OUTLINE_NAV_BREADCRUMB): Array<Record<string, unknown>> {
    return infoSpy.mock.calls.flatMap(([first]) => {
      if (typeof first !== 'string') return [];
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(first) as Record<string, unknown>;
      } catch {
        return [];
      }
      return parsed.event === event ? [parsed] : [];
    });
  }

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

  async function mountEditor(): Promise<ReturnType<typeof render>> {
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(tree(false));
    });
    if (!result) throw new Error('render did not commit');
    return result;
  }

  async function clickOutlineRow(detail: Partial<OutlineNavDetail>): Promise<void> {
    const full: OutlineNavDetail = {
      docName: DOC_NAME,
      index: 0,
      slug: 'alpha',
      mode: 'wysiwyg',
      ...detail,
    };
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OUTLINE_NAV_EVENT, { detail: full }));
    });
  }

  test('HeadingAnchors assigns the slug ids the drift check reads', async () => {
    await mountEditor();
    const ids = Array.from(
      editorEntry?.editor.view.dom.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? [],
    ).map((h) => h.id);
    expect(ids).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('a click that resolves the row it asked for reports no drift', async () => {
    await mountEditor();
    await clickOutlineRow({ index: 2, slug: 'gamma' });
    expect(breadcrumbs()).toEqual([
      expect.objectContaining({
        docName: DOC_NAME,
        mode: 'wysiwyg',
        index: 2,
        domHeadingCount: 3,
        slugFoundAt: 2,
        outcome: 'scrolled',
        resolvedLevel: 2,
        scrollTopBefore: 250,
        scrollHeightBefore: 0,
      }),
    ]);
  });

  test('an ordinal that lands on the wrong heading reports the exact shift', async () => {
    await mountEditor();
    await clickOutlineRow({ index: 1, slug: 'gamma' });
    const [line] = breadcrumbs();
    expect(line).toMatchObject({
      index: 1,
      slugFoundAt: 2,
      domHeadingCount: 3,
      outcome: 'scrolled',
    });
    expect((line.slugFoundAt as number) - (line.index as number)).toBe(1);
  });

  test('an out-of-range ordinal reports the count that made it out of range', async () => {
    await mountEditor();
    await clickOutlineRow({ index: 9, slug: 'nowhere' });
    expect(breadcrumbs()).toEqual([
      expect.objectContaining({
        index: 9,
        domHeadingCount: 3,
        slugFoundAt: -1,
        outcome: 'no-target',
      }),
    ]);
  });

  test('a declined claim is recorded rather than read as a completed scroll', async () => {
    await mountEditor();
    registerLandingScrollOwner(DOC_NAME, {
      yieldsToNavigation: false,
      supersede: () => {},
    });
    await clickOutlineRow({ index: 0, slug: 'alpha' });
    expect(breadcrumbs()).toEqual([
      expect.objectContaining({ index: 0, outcome: 'declined', slugFoundAt: 0 }),
    ]);
  });

  test('a click arriving before the view mounts is reported, not swallowed', async () => {
    await mountEditor();
    viewUnavailable = true;
    try {
      await clickOutlineRow({ index: 0, slug: 'alpha' });
    } finally {
      viewUnavailable = false;
    }
    expect(breadcrumbs()).toEqual([
      expect.objectContaining({ docName: DOC_NAME, index: 0, outcome: 'no-view' }),
    ]);
  });

  test('the scroller is this editor own, not whichever pane happens to be painted', async () => {
    const otherPane = document.createElement('div');
    otherPane.setAttribute('data-testid', 'editor-scroll-container');
    otherPane.scrollTop = 8888;
    document.body.insertBefore(otherPane, document.body.firstChild);
    try {
      await mountEditor();
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      expect(breadcrumbs()).toEqual([
        expect.objectContaining({ scrollTopBefore: 250, outcome: 'scrolled' }),
      ]);
    } finally {
      otherPane.remove();
    }
  });

  test('a click for another document is not this editor to report', async () => {
    await mountEditor();
    await clickOutlineRow({ docName: 'some/other-doc', index: 0, slug: 'alpha' });
    expect(breadcrumbs()).toEqual([]);
  });

  test('a source-mode click is not this consumer to report', async () => {
    await mountEditor();
    await clickOutlineRow({ index: 0, slug: 'alpha', mode: 'source' });
    expect(breadcrumbs()).toEqual([]);
  });

  test('where the scroller came to rest arrives after the smooth scroll settles', async () => {
    vi.useFakeTimers();
    try {
      await mountEditor();
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      expect(breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB)).toEqual([]);
      if (scroller) scroller.scrollTop = 40;
      await act(async () => {
        vi.runAllTimers();
      });
      expect(breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB)).toEqual([
        expect.objectContaining({
          docName: DOC_NAME,
          index: 0,
          scrollTopAfter: 40,
          targetTopAfter: 0,
          scrollHeightAfter: 0,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the settle read re-measures the target, not just where the scroller stopped', async () => {
    vi.useFakeTimers();
    try {
      await mountEditor();
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      const target = editorEntry?.editor.view.dom.querySelector('h1');
      if (!target || !scroller) throw new Error('fixture not prepared');
      target.getBoundingClientRect = () => ({ top: 17_000 }) as DOMRect;
      Object.defineProperty(scroller, 'scrollHeight', { value: 26_000, configurable: true });
      await act(async () => {
        vi.runAllTimers();
      });
      expect(breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB)).toEqual([
        expect.objectContaining({ targetTopAfter: 17_000, scrollHeightAfter: 26_000 }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a heading replaced mid-animation reports its absence, not a zero-rect position', async () => {
    vi.useFakeTimers();
    try {
      await mountEditor();
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      editorEntry?.editor.view.dom.querySelector('h1')?.remove();
      await act(async () => {
        vi.runAllTimers();
      });
      const [line] = breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB);
      expect(line).toMatchObject({ targetDetached: true, scrollerDetached: false });
      expect('targetTopAfter' in line).toBe(false);
      expect(line.scrollTopAfter).toBe(250);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the before-scroll height is read before the scroll, not after it', async () => {
    await mountEditor();
    if (!scroller) throw new Error('fixture not prepared');
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () =>
        vi.mocked(HTMLElement.prototype.scrollIntoView).mock.calls.length > 0 ? 99_999 : 1234,
      configurable: true,
    });
    await clickOutlineRow({ index: 0, slug: 'alpha' });
    expect(breadcrumbs()).toEqual([
      expect.objectContaining({ scrollHeightBefore: 1234, outcome: 'scrolled' }),
    ]);
  });

  test('unmounting cancels the pending settle read rather than firing it late', async () => {
    vi.useFakeTimers();
    try {
      await mountEditor();
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      cleanup();
      await act(async () => {
        vi.runAllTimers();
      });
      expect(breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('flipping to source mode cancels the settle instead of measuring the other pane', async () => {
    vi.useFakeTimers();
    try {
      const result = await mountEditor();
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      await act(async () => {
        result.rerender(tree(true));
      });
      await act(async () => {
        vi.runAllTimers();
      });
      expect(breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the settled line names its surface, like both of its siblings', async () => {
    vi.useFakeTimers();
    try {
      await mountEditor();
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      await act(async () => {
        vi.runAllTimers();
      });
      expect(breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB)).toEqual([
        expect.objectContaining({ mode: 'wysiwyg' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('rapid clicking settles once, on the landing that survived', async () => {
    vi.useFakeTimers();
    try {
      await mountEditor();
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      await clickOutlineRow({ index: 2, slug: 'gamma' });
      await act(async () => {
        vi.runAllTimers();
      });
      expect(breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB)).toEqual([
        expect.objectContaining({ index: 2 }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the settle read measures the scroller the click measured, not the visible one', async () => {
    vi.useFakeTimers();
    try {
      await mountEditor();
      const clicked = scroller;
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      if (clicked) clicked.scrollTop = 77;

      const otherDoc = document.createElement('div');
      otherDoc.setAttribute('data-testid', 'editor-scroll-container');
      otherDoc.getClientRects = (() => [{}]) as unknown as Element['getClientRects'];
      document.body.insertBefore(otherDoc, document.body.firstChild);
      otherDoc.scrollTop = 9999;
      scroller = otherDoc;

      await act(async () => {
        vi.runAllTimers();
      });
      expect(breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB)).toEqual([
        expect.objectContaining({ scrollTopAfter: 77, scrollerDetached: false }),
      ]);
      otherDoc.remove();
      scroller = clicked;
    } finally {
      vi.useRealTimers();
    }
  });

  test('a scroller torn down before the settle reports the teardown, not a zero', async () => {
    vi.useFakeTimers();
    try {
      await mountEditor();
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      scroller?.remove();
      await act(async () => {
        vi.runAllTimers();
      });
      const [line] = breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB);
      expect(line).toMatchObject({ scrollerDetached: true });
      expect('scrollTopAfter' in line).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a declined click schedules no settle read, having moved nothing', async () => {
    vi.useFakeTimers();
    try {
      await mountEditor();
      registerLandingScrollOwner(DOC_NAME, { yieldsToNavigation: false, supersede: () => {} });
      await clickOutlineRow({ index: 0, slug: 'alpha' });
      await act(async () => {
        vi.runAllTimers();
      });
      expect(breadcrumbs(OUTLINE_NAV_SETTLED_BREADCRUMB)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
