import type { EditorView } from '@codemirror/view';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getCollector } from '../lib/perf/collector';
import type { PerfMark } from '../lib/perf/types';
import { getEditorForDoc, registerEditor, unregisterEditor } from './active-editor';
import {
  __caretRevealTargetFor,
  CARET_REVEAL_GAP_PX,
  revealCaretAboveComposerCard,
} from './caret-reveal';
import {
  DOCUMENT_SCROLL_HOST_CLASS,
  FULL_PAGE_CM_HOST_SELECTORS,
  FULL_PAGE_CM_SCROLLPORTS,
  type FullPageCmHost,
} from './document-scrollports';
import {
  getFullPageCmEntryForDoc,
  registerFullPageCmView,
  unregisterFullPageCmView,
} from './full-page-cm-views';

const FULL_PAGE_CM_HOSTS = Object.keys(FULL_PAGE_CM_HOST_SELECTORS) as FullPageCmHost[];

const DOC_NAME = 'caret-reveal-doc';

const CARET_BOTTOM = 620;
const LINE_HEIGHT = 18;
const RESTING_SCROLL_TOP = 1000;
const SELECTION_HEAD = 41;
const PORT_BOTTOM_BELOW_THE_CARD = 2000;
const COORDS_FAILED_MARK = 'ok/caret-reveal/coords-failed';
const WYSIWYG_COORDS_THROW_MESSAGE = 'no position for the given offset';
const SOURCE_COORDS_THROW_MESSAGE = `Invalid position ${SELECTION_HEAD} in document of length 0`;

function rectAt(bottom: number): { top: number; bottom: number; left: number; right: number } {
  return { top: bottom - LINE_HEIGHT, bottom, left: 0, right: 0 };
}

function stubPortRect(element: HTMLElement, bottom: number): void {
  element.getBoundingClientRect = () => new DOMRect(0, 0, 0, bottom);
}

function stubLaidOut(element: HTMLElement): void {
  element.getClientRects = () => [new DOMRect(0, 0, 0, LINE_HEIGHT)] as unknown as DOMRectList;
}

const CARD_HEIGHT = 120;

function cardAt(top: number): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => new DOMRect(0, top, 0, CARD_HEIGHT);
  return element;
}

function mountCmHost(
  host: FullPageCmHost,
  portBottom = PORT_BOTTOM_BELOW_THE_CARD,
): { outer: HTMLElement; scroller: HTMLElement } {
  const outer = document.createElement('div');
  outer.className = DOCUMENT_SCROLL_HOST_CLASS;
  const selector = FULL_PAGE_CM_HOST_SELECTORS[host];
  const hostEl = document.createElement('div');
  if (selector.startsWith('[')) hostEl.setAttribute(selector.slice(1, -1), '');
  else hostEl.className = selector.slice(1);
  const scroller = document.createElement('div');
  scroller.className = 'cm-scroller';
  hostEl.append(scroller);
  outer.append(hostEl);
  document.body.append(outer);
  stubPortRect(outer, portBottom);
  stubPortRect(scroller, portBottom);
  return { outer, scroller };
}

function mountWysiwygHost({ laidOut = true } = {}): { outer: HTMLElement; dom: HTMLElement } {
  const outer = document.createElement('div');
  outer.className = DOCUMENT_SCROLL_HOST_CLASS;
  const dom = document.createElement('div');
  dom.className = 'ProseMirror';
  outer.append(dom);
  document.body.append(outer);
  stubPortRect(outer, PORT_BOTTOM_BELOW_THE_CARD);
  if (laidOut) stubLaidOut(dom);
  return { outer, dom };
}

function cmViewStub(
  scroller: HTMLElement,
  caretBottom: number | null | 'throws',
  reads: number[] = [],
): EditorView {
  return {
    scrollDOM: scroller,
    state: { selection: { main: { head: SELECTION_HEAD } } },
    coordsAtPos: (pos: number) => {
      reads.push(pos);
      if (caretBottom === 'throws') throw new RangeError(SOURCE_COORDS_THROW_MESSAGE);
      return caretBottom === null ? null : rectAt(caretBottom);
    },
  } as unknown as EditorView;
}

function tiptapEditorStub(
  dom: HTMLElement,
  caretBottom: number | 'throws',
  reads: number[] = [],
): Editor {
  return {
    isDestroyed: false,
    editorView: {
      dom,
      state: { selection: { head: SELECTION_HEAD } },
      coordsAtPos: (pos: number) => {
        reads.push(pos);
        if (caretBottom === 'throws') throw new RangeError(WYSIWYG_COORDS_THROW_MESSAGE);
        return rectAt(caretBottom);
      },
    },
  } as unknown as Editor;
}

function markNamed(name: string): PerfMark | undefined {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === name);
}

beforeEach(() => {
  getCollector()?.reset();
});

afterEach(() => {
  const entry = getFullPageCmEntryForDoc(DOC_NAME);
  if (entry) unregisterFullPageCmView(DOC_NAME, entry.view);
  const editor = getEditorForDoc(DOC_NAME);
  if (editor) unregisterEditor(DOC_NAME, editor);
  document.body.replaceChildren();
});

describe('__caretRevealTargetFor resolves a caret source and a scrollport for every surface the composer paints over', () => {
  test.each(FULL_PAGE_CM_HOSTS)('source mode on the %s host resolves both halves', (host) => {
    const { scroller } = mountCmHost(host);
    const reads: number[] = [];
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM, reads), host);

    const target = __caretRevealTargetFor(DOC_NAME, 'source');

    expect(
      target,
      `\`${host}\` is a registered full-page CodeMirror host, so the composer caret reveal must ` +
        'resolve a caret source AND a scrollport for it. A host that resolves nothing is a ' +
        'surface the card silently buries, which is exactly this bug',
    ).not.toBeNull();
    expect(target?.caretBottom).toBe(CARET_BOTTOM);
    expect(
      reads,
      'the caret rect must be read at the selection head, not at a fixed or stale position',
    ).toEqual([SELECTION_HEAD]);
    expect(
      target?.scrollport,
      `the scrollport must be the element \`FULL_PAGE_CM_SCROLLPORTS.${host}\` names, resolved ` +
        'from this host own scrollDOM',
    ).toBe(scroller.closest(FULL_PAGE_CM_SCROLLPORTS[host]));
  });

  test('markdown source mode resolves the outer document scroller, not its own cm-scroller', () => {
    const { outer, scroller } = mountCmHost('sourceEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'sourceEditor');

    const target = __caretRevealTargetFor(DOC_NAME, 'source');

    expect(
      target?.scrollport,
      'the source editor cm-scroller reserves the composer inset but never scrolls: the outer ' +
        '`.editor-doc-scroll` does. Delegating uniformly to the CodeMirror that owns the caret ' +
        'picks the wrong element here, which is why this host resolves through an ANCESTOR',
    ).toBe(outer);
    expect(target?.scrollport).not.toBe(scroller);
  });

  test('wysiwyg resolves through the registered TipTap editor and the document scroll host', () => {
    const { outer, dom } = mountWysiwygHost();
    const reads: number[] = [];
    registerEditor(DOC_NAME, tiptapEditorStub(dom, CARET_BOTTOM, reads));

    const target = __caretRevealTargetFor(DOC_NAME, 'wysiwyg');

    expect(target?.caretBottom).toBe(CARET_BOTTOM);
    expect(target?.scrollport).toBe(outer);
    expect(reads).toEqual([SELECTION_HEAD]);
  });

  test('wysiwyg resolves nothing from a CodeMirror registered for the same document', () => {
    const { scroller } = mountCmHost('mermaidDocEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'mermaidDocEditor');

    expect(
      __caretRevealTargetFor(DOC_NAME, 'wysiwyg'),
      'a mermaid doc in diagram mode reports the wysiwyg surface while its only registered view is ' +
        'a CodeMirror. There is no caret in diagram mode, so the reveal must resolve nothing rather ' +
        'than reach across surfaces',
    ).toBeNull();
  });

  test('the frontmatter surface resolves nothing even while a source view is registered', () => {
    const { scroller } = mountCmHost('sourceEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'sourceEditor');

    expect(
      __caretRevealTargetFor(DOC_NAME, 'frontmatter'),
      '`editingSurfaceFor` only ever yields wysiwyg or source, so the composer never reports this ' +
        'surface. The arm exists so a fourth `EditorSurface` cannot compile without a decision',
    ).toBeNull();
  });

  test('resolves nothing for a destroyed TipTap editor still sitting in the registry', () => {
    const { dom } = mountWysiwygHost();
    registerEditor(DOC_NAME, {
      ...tiptapEditorStub(dom, CARET_BOTTOM),
      isDestroyed: true,
    } as unknown as Editor);

    expect(
      __caretRevealTargetFor(DOC_NAME, 'wysiwyg'),
      'a recycled editor outlives its registry entry, and reading coordinates off a destroyed ' +
        'ProseMirror view is what this gate exists to prevent',
    ).toBeNull();
  });

  test('resolves nothing for a registered TipTap editor that paints no layout box', () => {
    const { dom } = mountWysiwygHost({ laidOut: false });
    registerEditor(DOC_NAME, tiptapEditorStub(dom, CARET_BOTTOM));

    expect(
      __caretRevealTargetFor(DOC_NAME, 'wysiwyg'),
      'a ProseMirror still in the registry and still in the document, but superseded so it lays ' +
        'out no box, reports caret coordinates against a viewport it no longer occupies. ' +
        'Scrolling a live scrollport by that overlap moves the surface the user IS looking at to ' +
        'chase a caret nobody can see',
    ).toBeNull();

    stubLaidOut(dom);

    expect(
      __caretRevealTargetFor(DOC_NAME, 'wysiwyg')?.caretBottom,
      'the same editor, registry entry and scrollport must resolve once the host paints a box, ' +
        'or the assertion above would hold for some reason other than the absent layout',
    ).toBe(CARET_BOTTOM);
  });

  test('resolves nothing while the TipTap editor has not mounted its ProseMirror view', () => {
    mountWysiwygHost();
    registerEditor(DOC_NAME, { isDestroyed: false } as unknown as Editor);

    expect(
      __caretRevealTargetFor(DOC_NAME, 'wysiwyg'),
      'TipTap exposes no `editorView` until ProseMirror mounts, and the reveal runs from a ' +
        'requestAnimationFrame that can land inside that window',
    ).toBeNull();
  });

  test('resolves nothing for a document with no registered view on either registry', () => {
    mountCmHost('textDocEditor');
    mountWysiwygHost();

    expect(__caretRevealTargetFor(DOC_NAME, 'source')).toBeNull();
    expect(__caretRevealTargetFor(DOC_NAME, 'wysiwyg')).toBeNull();
  });

  test('resolves nothing when the view cannot report caret coordinates', () => {
    const { scroller } = mountCmHost('textDocEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, null), 'textDocEditor');

    expect(__caretRevealTargetFor(DOC_NAME, 'source')).toBeNull();
  });

  test('resolves nothing, and does not throw, when a coordsAtPos read throws', () => {
    const { dom } = mountWysiwygHost();
    registerEditor(DOC_NAME, tiptapEditorStub(dom, 'throws'));

    expect(
      () => __caretRevealTargetFor(DOC_NAME, 'wysiwyg'),
      'ProseMirror `coordsAtPos` throws rather than returning null for an unmapped position, and ' +
        'this runs inside a requestAnimationFrame where an escaping throw is unhandled',
    ).not.toThrow();
    expect(__caretRevealTargetFor(DOC_NAME, 'wysiwyg')).toBeNull();
    expect(
      markNamed(COORDS_FAILED_MARK)?.properties,
      'swallowing the throw is what keeps the frame alive, so this mark is the only trace the ' +
        'degradation leaves. Without it a caret that has silently stopped revealing reads exactly ' +
        'like one that never needed revealing, and a trace naming neither the document nor the ' +
        'arm it failed on cannot separate this ProseMirror read from the three CodeMirror hosts ' +
        'the same mark also covers',
    ).toEqual({
      docName: DOC_NAME,
      surface: 'wysiwyg',
      message: WYSIWYG_COORDS_THROW_MESSAGE,
    });

    getCollector()?.reset();
    registerEditor(DOC_NAME, tiptapEditorStub(dom, CARET_BOTTOM));

    expect(__caretRevealTargetFor(DOC_NAME, 'wysiwyg')?.caretBottom).toBe(CARET_BOTTOM);
    expect(
      markNamed(COORDS_FAILED_MARK),
      'a read that resolves must leave the mark absent, or the assertion above would also hold ' +
        'for a build that marks unconditionally',
    ).toBeUndefined();
  });

  test('resolves nothing, and does not throw, when a source mode coordsAtPos read throws', () => {
    const { scroller } = mountCmHost('textDocEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, 'throws'), 'textDocEditor');

    expect(
      () => __caretRevealTargetFor(DOC_NAME, 'source'),
      'CodeMirror `coordsAtPos` reaches `state.doc.lineAt(pos)` once the view resolves a ' +
        'non-empty rect, and `lineAt` throws a RangeError for a position past the document ' +
        'length rather than returning null. This arm runs from the same requestAnimationFrame ' +
        'as the wysiwyg one, where an escaping throw is unhandled',
    ).not.toThrow();
    expect(__caretRevealTargetFor(DOC_NAME, 'source')).toBeNull();
    expect(
      markNamed(COORDS_FAILED_MARK)?.properties,
      'both arms reach this one catch, so the surface the mark records is the only thing that ' +
        'tells a CodeMirror failure apart from a ProseMirror one. Naming the wrong arm here still ' +
        'typechecks, and it sends triage to a view type that never ran',
    ).toEqual({
      docName: DOC_NAME,
      surface: 'source',
      message: SOURCE_COORDS_THROW_MESSAGE,
    });
  });

  test('resolves nothing when the host sits outside its scrollport', () => {
    const orphan = document.createElement('div');
    orphan.className = 'cm-scroller';
    document.body.append(orphan);
    registerFullPageCmView(DOC_NAME, cmViewStub(orphan, CARET_BOTTOM), 'textDocEditor');

    expect(__caretRevealTargetFor(DOC_NAME, 'source')).toBeNull();
  });
});

describe('revealCaretAboveComposerCard scrolls exactly the overlap the card creates', () => {
  test('scrolls a buried caret line clear of the card', () => {
    const { scroller } = mountCmHost('textDocEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'textDocEditor');
    scroller.scrollTop = RESTING_SCROLL_TOP;
    const cardTop = CARET_BOTTOM - 10;

    revealCaretAboveComposerCard({
      docName: DOC_NAME,
      surface: 'source',
      card: cardAt(cardTop),
    });

    expect(scroller.scrollTop).toBe(
      RESTING_SCROLL_TOP + (CARET_BOTTOM - (cardTop - CARET_REVEAL_GAP_PX)),
    );
  });

  test('markdown source mode scrolls the outer document scroller and leaves its cm-scroller alone', () => {
    const { outer, scroller } = mountCmHost('sourceEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'sourceEditor');
    outer.scrollTop = RESTING_SCROLL_TOP;
    scroller.scrollTop = RESTING_SCROLL_TOP;
    const cardTop = CARET_BOTTOM - 10;

    revealCaretAboveComposerCard({ docName: DOC_NAME, surface: 'source', card: cardAt(cardTop) });

    expect(outer.scrollTop).toBe(
      RESTING_SCROLL_TOP + (CARET_BOTTOM - (cardTop - CARET_REVEAL_GAP_PX)),
    );
    expect(
      scroller.scrollTop,
      'scrolling the source editor own cm-scroller moves nothing on screen: the outer ' +
        '`.editor-doc-scroll` is the element that scrolls this surface',
    ).toBe(RESTING_SCROLL_TOP);
  });

  test('leaves the caret alone when it already clears the card by exactly the reveal gap', () => {
    const { scroller } = mountCmHost('textDocEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'textDocEditor');
    scroller.scrollTop = RESTING_SCROLL_TOP;

    revealCaretAboveComposerCard({
      docName: DOC_NAME,
      surface: 'source',
      card: cardAt(CARET_BOTTOM + CARET_REVEAL_GAP_PX),
    });

    expect(scroller.scrollTop).toBe(RESTING_SCROLL_TOP);
  });

  test('scrolls by one pixel when the caret sits one pixel inside the reveal gap', () => {
    const { scroller } = mountCmHost('textDocEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'textDocEditor');
    scroller.scrollTop = RESTING_SCROLL_TOP;

    revealCaretAboveComposerCard({
      docName: DOC_NAME,
      surface: 'source',
      card: cardAt(CARET_BOTTOM + CARET_REVEAL_GAP_PX - 1),
    });

    expect(
      scroller.scrollTop,
      'CARET_REVEAL_GAP_PX is the clearance the caret line must keep above the card, not a ' +
        'threshold the overlap has to exceed before anything happens',
    ).toBe(RESTING_SCROLL_TOP + 1);
  });

  test('leaves the caret alone when it already paints well above the card', () => {
    const { scroller } = mountCmHost('textDocEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'textDocEditor');
    scroller.scrollTop = RESTING_SCROLL_TOP;

    revealCaretAboveComposerCard({
      docName: DOC_NAME,
      surface: 'source',
      card: cardAt(CARET_BOTTOM + 400),
    });

    expect(scroller.scrollTop).toBe(RESTING_SCROLL_TOP);
  });

  test('leaves the scrollport untouched once the document has no registered view', () => {
    const { scroller } = mountCmHost('textDocEditor');
    const view = cmViewStub(scroller, CARET_BOTTOM);
    const cardTop = CARET_BOTTOM - 10;
    registerFullPageCmView(DOC_NAME, view, 'textDocEditor');
    scroller.scrollTop = RESTING_SCROLL_TOP;

    revealCaretAboveComposerCard({ docName: DOC_NAME, surface: 'source', card: cardAt(cardTop) });

    expect(
      scroller.scrollTop,
      'this same scrollport, card and caret must move while a view IS registered, or the no-op ' +
        'assertion below would hold for the wrong reason',
    ).toBeGreaterThan(RESTING_SCROLL_TOP);

    unregisterFullPageCmView(DOC_NAME, view);
    scroller.scrollTop = RESTING_SCROLL_TOP;

    revealCaretAboveComposerCard({ docName: DOC_NAME, surface: 'source', card: cardAt(cardTop) });

    expect(scroller.scrollTop).toBe(RESTING_SCROLL_TOP);
  });

  test('leaves the scrollport untouched when the view cannot report caret coordinates', () => {
    const { scroller } = mountCmHost('textDocEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, null), 'textDocEditor');
    scroller.scrollTop = RESTING_SCROLL_TOP;

    revealCaretAboveComposerCard({
      docName: DOC_NAME,
      surface: 'source',
      card: cardAt(CARET_BOTTOM - 10),
    });

    expect(scroller.scrollTop).toBe(RESTING_SCROLL_TOP);
  });

  test('clears the scrollport own bottom edge when the host inset lifts it above the card', () => {
    const hostRoutePortBottom = CARET_BOTTOM - 40;
    const { scroller } = mountCmHost('mermaidDocEditor', hostRoutePortBottom);
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'mermaidDocEditor');
    scroller.scrollTop = RESTING_SCROLL_TOP;
    const cardTop = hostRoutePortBottom + 48;

    revealCaretAboveComposerCard({
      docName: DOC_NAME,
      surface: 'source',
      card: cardAt(cardTop),
    });

    expect(
      scroller.scrollTop,
      'the mermaid host reserves the composer band on its own border box, so its cm-scroller ' +
        'stops 48px ABOVE the card. Clearing the card top alone parks the caret line in the ' +
        'clipped strip between the two, where it paints nothing',
    ).toBe(RESTING_SCROLL_TOP + (CARET_BOTTOM - (hostRoutePortBottom - CARET_REVEAL_GAP_PX)));
  });

  test('leaves a scrollport with no layout box untouched', () => {
    const { scroller } = mountCmHost('textDocEditor', 0);
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'textDocEditor');
    scroller.scrollTop = RESTING_SCROLL_TOP;

    revealCaretAboveComposerCard({
      docName: DOC_NAME,
      surface: 'source',
      card: cardAt(CARET_BOTTOM + 400),
    });

    expect(
      scroller.scrollTop,
      'a scrollport laid out with no height reports a bottom edge at the TOP of the viewport, and ' +
        '`Math.min` picks it as the occlusion line. That inverts the clamp: a caret painting well ' +
        'clear of the card yields the maximum possible overlap instead of none. Reaching that ' +
        'state through `display: none` would be harmless, because CSSOM View makes the `scrollTop` ' +
        'setter a no-op for an element with no associated box. A collapsed but boxed scrollport ' +
        'has no such protection',
    ).toBe(RESTING_SCROLL_TOP);
  });

  test('leaves the scrollport untouched when the card has no layout box', () => {
    const { scroller } = mountCmHost('textDocEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'textDocEditor');
    scroller.scrollTop = RESTING_SCROLL_TOP;
    const boxless = document.createElement('div');
    boxless.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

    revealCaretAboveComposerCard({ docName: DOC_NAME, surface: 'source', card: boxless });

    expect(
      scroller.scrollTop,
      'a card with no layout box reports a top of 0, which `Math.min` then takes as the occlusion ' +
        'line for ANY scrollport. The overlap is positive for every caret below -CARET_REVEAL_GAP_PX ' +
        'and no later exit can catch it, so this is the same inversion as the scrollport case and ' +
        'is answered by the same rule',
    ).toBe(RESTING_SCROLL_TOP);
  });

  test('leaves the frontmatter surface untouched', () => {
    const { outer, scroller } = mountCmHost('sourceEditor');
    registerFullPageCmView(DOC_NAME, cmViewStub(scroller, CARET_BOTTOM), 'sourceEditor');
    outer.scrollTop = RESTING_SCROLL_TOP;

    revealCaretAboveComposerCard({
      docName: DOC_NAME,
      surface: 'frontmatter',
      card: cardAt(CARET_BOTTOM - 10),
    });

    expect(outer.scrollTop).toBe(RESTING_SCROLL_TOP);
  });
});
