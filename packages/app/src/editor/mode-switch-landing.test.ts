// @vitest-environment jsdom
import { EditorState as CmEditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView as CodeMirrorView, DecorationSet } from '@codemirror/view';
import { MarkdownManager, sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { type Editor, getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState as PmEditorState } from '@tiptap/pm/state';
import type { EditorView as ProseMirrorView } from '@tiptap/pm/view';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { getCollector } from '../lib/perf/collector.ts';
import { registerEditor, unregisterEditor } from './active-editor.ts';
import { registerSourceView, unregisterSourceView } from './active-source-view.ts';
import {
  buildSourceLandingNav,
  buildWysiwygLandingNav,
  captureModeSwitchAnchor,
  requestViewInSource,
  resolveSourceLandingTarget,
  resolveWysiwygLandingTarget,
  sourceTargetMetrics,
  startSourceLanding,
  startWysiwygLanding,
  wysiwygTargetMetrics,
} from './mode-switch-landing.ts';
import { type BlockAnchor, createApproxResolver } from './mode-switch-position-resolver.ts';
import { blockRangeToPositions } from './plugins/agent-insert-flash.ts';
import { FLASH_DURATION_MS } from './plugins/flash-shared.ts';
import { landingFlashField } from './plugins/landing-flash-source.ts';
import { createLandingFlashPlugin, landingFlashKey } from './plugins/landing-flash-wysiwyg.ts';
import { __resetScrollRestoreCoordination } from './scroll-restore-coordination.ts';
import {
  clearPendingSourceNavigationsForTest,
  clearPendingWysiwygNavigationsForTest,
  peekPendingSourceNavigation,
  peekPendingWysiwygNavigation,
  rememberPendingSourceNavigation,
  resolveNavigationPin,
  type SelectionOffsetNavigation,
} from './source-editor-navigation.ts';
import { VIEW_IN_SOURCE_EVENT, type ViewInSourceDetail } from './view-in-source-event.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);
const resolver = createApproxResolver(md);

function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value, got null/undefined');
  return value;
}

function setup(markdown: string): { doc: PmNode; ydoc: Y.Doc; ytext: Y.Text; source: string } {
  const { body } = stripFrontmatter(markdown);
  const doc = schema.nodeFromJSON(md.parse(body));
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ytext.insert(0, markdown);
  return { doc, ydoc, ytext, source: markdown };
}

function pmPosOfBlock(doc: PmNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos + 1;
}

function pmBlockStart(doc: PmNode, index: number): number {
  return present(blockRangeToPositions(doc, index, index + 1)).from;
}

function docFrom(source: string): PmNode {
  return schema.nodeFromJSON(md.parse(stripFrontmatter(source).body));
}

describe('buildSourceLandingNav', () => {
  test('captures the block under the position with a pin over its source range', () => {
    const { doc, ydoc, ytext, source } = setup('# Title\n\nfirst\n\n## Second\n\ntarget para');
    const nav = present(buildSourceLandingNav(doc, pmPosOfBlock(doc, 3), ytext, resolver));
    expect(nav.kind).toBe('selection-offset');
    expect(nav.anchor).toMatchObject({ blockIndex: 3, content: 'target para' });
    expect(resolveNavigationPin(present(nav.pin), ydoc)).toBe(source.indexOf('target para'));
  });

  test('omits the pin when the body has no top-level block to pin', () => {
    const { doc, ytext } = setup('');
    const nav = buildSourceLandingNav(doc, 0, ytext, resolver);
    expect(nav?.pin).toBeUndefined();
  });
});

describe('resolveSourceLandingTarget', () => {
  test('resolves the anchor ordinal to the matching source block with no pin', () => {
    const { doc, ydoc, source } = setup('# A\n\nfirst\n\ntarget');
    const anchor = present(resolver.captureFromSource(source, source.indexOf('target')));
    const nav: SelectionOffsetNavigation = { kind: 'selection-offset', anchor };
    const resolved = present(
      resolveSourceLandingTarget(nav, { source, pmDoc: doc, ydoc, resolver }),
    );
    expect(resolved.blockStart).toBe(source.indexOf('target'));
  });

  test('a surviving pin tracks a block a remote insert moved, beating the stale ordinal', () => {
    const { doc, ydoc, ytext, source } = setup('# A\n\nfirst para\n\ntarget para');
    const nav = present(buildSourceLandingNav(doc, pmPosOfBlock(doc, 2), ytext, resolver));

    ydoc.transact(() => ytext.insert(source.indexOf('first para'), 'inserted para\n\n'));
    const moved = ytext.toString();

    const resolved = present(
      resolveSourceLandingTarget(nav, { source: moved, pmDoc: docFrom(moved), ydoc, resolver }),
    );
    expect(resolved.blockStart).toBe(moved.indexOf('target para'));
  });

  test('a deleted pin degrades to a clamped landing rather than a stale offset', () => {
    const { doc, ydoc, ytext, source } = setup('# A\n\nfirst para\n\ntarget para');
    const nav = present(buildSourceLandingNav(doc, pmPosOfBlock(doc, 2), ytext, resolver));

    const start = source.indexOf('target para');
    ydoc.transact(() => ytext.delete(start, ytext.length - start));
    const shrunk = ytext.toString();

    const resolved = present(
      resolveSourceLandingTarget(nav, { source: shrunk, pmDoc: docFrom(shrunk), ydoc, resolver }),
    );
    expect(resolved.confidence).toBe('clamped');
  });

  test('returns null when the body has no blocks to land on', () => {
    const { doc, ydoc } = setup('');
    const anchor: BlockAnchor = { blockIndex: 0, kind: 'paragraph', content: '' };
    const nav: SelectionOffsetNavigation = { kind: 'selection-offset', anchor };
    expect(resolveSourceLandingTarget(nav, { source: '', pmDoc: doc, ydoc, resolver })).toBeNull();
  });
});

describe('buildWysiwygLandingNav', () => {
  test('captures the source block under the offset with a pin over its source range', () => {
    const { doc, ydoc, ytext, source } = setup('# Title\n\nfirst\n\n## Second\n\ntarget para');
    const off = source.indexOf('target para');
    const nav = present(buildWysiwygLandingNav(source, off, ytext, resolver, doc));
    expect(nav.kind).toBe('selection-offset');
    expect(nav.anchor).toMatchObject({ blockIndex: 3, content: 'target para' });
    expect(resolveNavigationPin(present(nav.pin), ydoc)).toBe(off);
  });

  test('omits the pin when no WYSIWYG doc is available to derive the source range', () => {
    const { ytext, source } = setup('# Title\n\ntarget');
    const nav = present(
      buildWysiwygLandingNav(source, source.indexOf('target'), ytext, resolver, undefined),
    );
    expect(nav.pin).toBeUndefined();
    expect(nav.anchor.blockIndex).toBe(1);
  });

  test('an offset inside the frontmatter region maps to the first body block', () => {
    const { doc, ytext, source } = setup('---\ntitle: hi\n---\n\n# Heading\n\nbody');
    const nav = present(
      buildWysiwygLandingNav(source, source.indexOf('title'), ytext, resolver, doc),
    );
    expect(nav.anchor.blockIndex).toBe(0);
  });

  test('returns null for an empty body with no block to capture', () => {
    const { ytext } = setup('');
    expect(buildWysiwygLandingNav('', 0, ytext, resolver, undefined)).toBeNull();
  });
});

describe('resolveWysiwygLandingTarget', () => {
  test('resolves the anchor ordinal to the matching WYSIWYG block with no pin', () => {
    const { doc, ydoc, source } = setup('# A\n\nfirst\n\ntarget');
    const anchor = present(resolver.captureFromSource(source, source.indexOf('target')));
    const nav: SelectionOffsetNavigation = { kind: 'selection-offset', anchor };
    const resolved = present(
      resolveWysiwygLandingTarget(nav, { source, pmDoc: doc, ydoc, resolver }),
    );
    expect(resolved.blockStart).toBe(pmBlockStart(doc, 2));
  });

  test('a surviving pin tracks a block a remote insert moved, beating the stale ordinal', () => {
    const { doc, ydoc, ytext, source } = setup('# A\n\nfirst para\n\ntarget para');
    const nav = present(
      buildWysiwygLandingNav(source, source.indexOf('target para'), ytext, resolver, doc),
    );

    ydoc.transact(() => ytext.insert(source.indexOf('first para'), 'inserted para\n\n'));
    const moved = ytext.toString();
    const movedDoc = docFrom(moved);

    const resolved = present(
      resolveWysiwygLandingTarget(nav, { source: moved, pmDoc: movedDoc, ydoc, resolver }),
    );
    expect(resolved.blockStart).toBe(pmBlockStart(movedDoc, 3));
  });

  test('a deleted pin degrades to a clamped landing rather than a stale ordinal', () => {
    const { doc, ydoc, ytext, source } = setup('# A\n\nfirst para\n\ntarget para');
    const nav = present(
      buildWysiwygLandingNav(source, source.indexOf('target para'), ytext, resolver, doc),
    );

    const start = source.indexOf('target para');
    ydoc.transact(() => ytext.delete(start, ytext.length - start));
    const shrunk = ytext.toString();

    const resolved = present(
      resolveWysiwygLandingTarget(nav, { source: shrunk, pmDoc: docFrom(shrunk), ydoc, resolver }),
    );
    expect(resolved.confidence).toBe('clamped');
  });

  test('returns null when the doc has no block to land on', () => {
    const { doc, ydoc } = setup('');
    const anchor: BlockAnchor = { blockIndex: 0, kind: 'paragraph', content: '' };
    const nav: SelectionOffsetNavigation = { kind: 'selection-offset', anchor };
    expect(resolveWysiwygLandingTarget(nav, { source: '', pmDoc: doc, ydoc, resolver })).toBeNull();
  });
});

describe('sourceTargetMetrics', () => {
  test('uses the measured rect from coordsAtPos when the target line is rendered', () => {
    const view = {
      state: { doc: { length: 1000 } },
      coordsAtPos: () => ({ top: 66, bottom: 86, left: 0, right: 0 }),
      documentTop: 999,
      lineBlockAt: () => ({ top: 999, height: 999 }),
    } as unknown as CodeMirrorView;
    const container = {
      getBoundingClientRect: () => ({ top: 10 }) as DOMRect,
      scrollTop: 100,
    } as unknown as HTMLElement;

    expect(sourceTargetMetrics(view, container, 300)).toEqual({ top: 156, height: 20 });
  });

  test('falls back to the height-map estimate only while the line is off-viewport', () => {
    const view = {
      state: { doc: { length: 1000 } },
      coordsAtPos: () => null,
      documentTop: 20,
      lineBlockAt: (pos: number) => ({ top: pos, height: 40 }),
    } as unknown as CodeMirrorView;
    const container = {
      getBoundingClientRect: () => ({ top: 10 }) as DOMRect,
      scrollTop: 100,
    } as unknown as HTMLElement;

    expect(sourceTargetMetrics(view, container, 300)).toEqual({ top: 410, height: 40 });
  });

  test('clamps an out-of-range offset to the document length before measuring', () => {
    let measuredAt = -1;
    const view = {
      state: { doc: { length: 500 } },
      coordsAtPos: (pos: number) => {
        measuredAt = pos;
        return null;
      },
      documentTop: 0,
      lineBlockAt: (pos: number) => ({ top: pos, height: 10 }),
    } as unknown as CodeMirrorView;
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
    } as unknown as HTMLElement;

    expect(sourceTargetMetrics(view, container, 9999)?.top).toBe(500);
    expect(measuredAt).toBe(500);
  });

  test('degrades to null when a torn-down view throws instead of measuring', () => {
    const view = {
      state: { doc: { length: 1000 } },
      coordsAtPos: () => {
        throw new TypeError('reading null docView');
      },
      documentTop: 0,
      lineBlockAt: () => {
        throw new TypeError('reading null docView');
      },
    } as unknown as CodeMirrorView;
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
    } as unknown as HTMLElement;

    expect(sourceTargetMetrics(view, container, 300)).toBeNull();
  });

  test('falls back to the height map when only the measured rect throws', () => {
    const view = {
      state: { doc: { length: 1000 } },
      coordsAtPos: () => {
        throw new RangeError('position out of range');
      },
      documentTop: 0,
      lineBlockAt: (pos: number) => ({ top: pos, height: 40 }),
    } as unknown as CodeMirrorView;
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
    } as unknown as HTMLElement;

    expect(sourceTargetMetrics(view, container, 300)).toEqual({ top: 300, height: 40 });
  });
});

describe('wysiwygTargetMetrics', () => {
  test('measures the block element rect in the scroller coordinate space', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ top: 66, bottom: 92, height: 26 }) as DOMRect;
    const view = {
      state: { doc: { content: { size: 1000 } } },
      nodeDOM: () => el,
      domAtPos: () => ({ node: el, offset: 0 }),
    } as unknown as ProseMirrorView;
    const container = {
      getBoundingClientRect: () => ({ top: 10 }) as DOMRect,
      scrollTop: 100,
    } as unknown as HTMLElement;

    expect(wysiwygTargetMetrics(view, container, 300)).toEqual({ top: 156, height: 26 });
  });

  test('returns null when the position resolves to no element', () => {
    const view = {
      state: { doc: { content: { size: 500 } } },
      nodeDOM: () => null,
      domAtPos: () => ({ node: { parentElement: null } as unknown as Node, offset: 0 }),
    } as unknown as ProseMirrorView;
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
    } as unknown as HTMLElement;
    expect(wysiwygTargetMetrics(view, container, 9999)).toBeNull();
  });

  test('returns null for a destroyed view without touching its DOM accessors', () => {
    let touched = false;
    const view = {
      isDestroyed: true,
      state: { doc: { content: { size: 500 } } },
      nodeDOM: () => {
        touched = true;
        return null;
      },
      domAtPos: () => {
        touched = true;
        return { node: document.createElement('div'), offset: 0 };
      },
    } as unknown as ProseMirrorView;
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
    } as unknown as HTMLElement;

    expect(wysiwygTargetMetrics(view, container, 300)).toBeNull();
    expect(touched).toBe(false);
  });

  test('degrades to null when a recycled view throws out of its DOM accessors', () => {
    const view = {
      state: { doc: { content: { size: 500 } } },
      nodeDOM: () => {
        throw new Error('view recycled');
      },
      domAtPos: () => {
        throw new Error('view recycled');
      },
    } as unknown as ProseMirrorView;
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
    } as unknown as HTMLElement;

    expect(wysiwygTargetMetrics(view, container, 300)).toBeNull();
  });
});

describe('captureModeSwitchAnchor', () => {
  beforeEach(() => {
    clearPendingSourceNavigationsForTest();
    clearPendingWysiwygNavigationsForTest();
  });

  test('does not overwrite a tool-driven raw-MDX target already queued for source', () => {
    const { ytext } = setup('# A\n\nbody');
    rememberPendingSourceNavigation('doc-raw', { kind: 'raw-mdx', detail: { offset: 5 } });
    captureModeSwitchAnchor({ from: 'wysiwyg', to: 'source', docName: 'doc-raw', ytext });
    expect(peekPendingSourceNavigation('doc-raw')?.kind).toBe('raw-mdx');
  });

  test('queues nothing when no WYSIWYG editor is registered for the doc', () => {
    const { ytext } = setup('# A\n\nbody');
    captureModeSwitchAnchor({ from: 'wysiwyg', to: 'source', docName: 'doc-none', ytext });
    expect(peekPendingSourceNavigation('doc-none')).toBeNull();
  });

  test('queues nothing for source-to-WYSIWYG when no source view is registered', () => {
    const { ytext } = setup('# A\n\nbody');
    captureModeSwitchAnchor({ from: 'source', to: 'wysiwyg', docName: 'doc-rev', ytext });
    expect(peekPendingWysiwygNavigation('doc-rev')).toBeNull();
  });

  test('queues a WYSIWYG landing for source-to-WYSIWYG from the registered source view', () => {
    const { ytext, source } = setup('# A\n\nfirst\n\ntarget para');
    const container = document.createElement('div');
    container.setAttribute('data-testid', 'editor-scroll-container');
    container.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 100, height: 400 }) as DOMRect;
    container.getClientRects = () =>
      [{ width: 100, height: 400 } as DOMRect] as unknown as DOMRectList;
    document.body.appendChild(container);
    const view = { posAtCoords: () => source.indexOf('target para') } as unknown as CodeMirrorView;
    registerSourceView('doc-fwd', view);
    try {
      captureModeSwitchAnchor({ from: 'source', to: 'wysiwyg', docName: 'doc-fwd', ytext });
      const nav = peekPendingWysiwygNavigation('doc-fwd');
      expect(nav?.kind).toBe('selection-offset');
      expect(nav?.anchor.content).toBe('target para');
      expect(peekPendingSourceNavigation('doc-fwd')).toBeNull();
    } finally {
      unregisterSourceView('doc-fwd', view);
      container.remove();
    }
  });
});

describe('buildSourceLandingNav intent', () => {
  test('a jump refines the anchor to the caret offset and marks the nav a jump', () => {
    const { doc, ytext } = setup('# Title\n\nfirst\n\ntarget paragraph');
    const nav = present(
      buildSourceLandingNav(doc, pmPosOfBlock(doc, 2) + 3, ytext, resolver, 'jump'),
    );
    expect(nav.intent).toBe('jump');
    expect(nav.anchor).toMatchObject({ blockIndex: 2, selectionInBlock: 3 });
  });

  test('a toggle stays scroll-only: no inline refinement, intent toggle', () => {
    const { doc, ytext } = setup('# Title\n\nfirst\n\ntarget paragraph');
    const nav = present(buildSourceLandingNav(doc, pmPosOfBlock(doc, 2) + 3, ytext, resolver));
    expect(nav.intent).toBe('toggle');
    expect(nav.anchor.selectionInBlock).toBeUndefined();
  });
});

describe('requestViewInSource', () => {
  beforeEach(() => {
    clearPendingSourceNavigationsForTest();
  });

  function fakeWysiwygEditor(doc: PmNode, caret: number): Editor {
    const view = { state: { doc, selection: { from: caret } } } as unknown as ProseMirrorView;
    return { editorView: view } as unknown as Editor;
  }

  test('banks a jump landing for the caret block and asks the pane to flip', () => {
    const { doc, ytext } = setup('# Title\n\nfirst\n\ntarget paragraph');
    const editor = fakeWysiwygEditor(doc, pmPosOfBlock(doc, 2) + 3);

    let flipped: string | null = null;
    const onFlip = (e: Event) => {
      flipped = (e as CustomEvent<ViewInSourceDetail>).detail.docName;
    };
    window.addEventListener(VIEW_IN_SOURCE_EVENT, onFlip);
    try {
      requestViewInSource({ editor, docName: 'doc-jump', ytext });
    } finally {
      window.removeEventListener(VIEW_IN_SOURCE_EVENT, onFlip);
    }

    const nav = peekPendingSourceNavigation('doc-jump');
    if (nav?.kind !== 'selection-offset') throw new Error('expected a selection-offset nav');
    expect(nav.intent).toBe('jump');
    expect(nav.anchor).toMatchObject({ blockIndex: 2, selectionInBlock: 3 });
    expect(flipped).toBe('doc-jump');
  });

  test('flips to source even for an empty-body doc', () => {
    const { doc, ytext } = setup('');
    const editor = fakeWysiwygEditor(doc, 0);

    let flipped = false;
    const onFlip = () => {
      flipped = true;
    };
    window.addEventListener(VIEW_IN_SOURCE_EVENT, onFlip);
    try {
      requestViewInSource({ editor, docName: 'doc-empty', ytext });
    } finally {
      window.removeEventListener(VIEW_IN_SOURCE_EVENT, onFlip);
    }

    expect(flipped).toBe(true);
    expect(peekPendingSourceNavigation('doc-empty')?.kind).toBe('selection-offset');
  });
});

const SETTLE_QUIET_MS = 150;
const ABANDON_WINDOW_MS = 2000;
const TOOLBAR_OVERLAP_PX = 56;
const VIEWPORT_HEIGHT = 800;
const SCROLL_HEIGHT = 6000;

function buildScrollContainer(): HTMLElement {
  const container = document.createElement('div');
  container.setAttribute('data-testid', 'editor-scroll-container');
  Object.defineProperty(container, 'clientHeight', {
    value: VIEWPORT_HEIGHT,
    configurable: true,
  });
  Object.defineProperty(container, 'scrollHeight', { value: SCROLL_HEIGHT, configurable: true });
  Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });
  container.getBoundingClientRect = () =>
    ({ top: 0, bottom: VIEWPORT_HEIGHT, left: 0, width: 600 }) as DOMRect;
  container.getClientRects = () =>
    [{ width: 600, height: VIEWPORT_HEIGHT } as DOMRect] as unknown as DOMRectList;
  document.body.appendChild(container);
  return container;
}

interface DrivenSourceView {
  view: CodeMirrorView;
  state: () => CmEditorState;
  setContentTop: (top: number) => void;
}

function drivenSourceView(
  markdown: string,
  container: HTMLElement,
  contentTop = 2000,
): DrivenSourceView {
  let state = CmEditorState.create({ doc: markdown, extensions: [landingFlashField] });
  let top = contentTop;
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
    coordsAtPos: () => ({ top: top - container.scrollTop, bottom: top - container.scrollTop + 20 }),
    lineBlockAt: () => ({ top, height: 20 }),
    documentTop: 0,
    contentDOM: document.createElement('div'),
    focus: () => {},
  };
  return {
    view: view as unknown as CodeMirrorView,
    state: () => state,
    setContentTop: (next: number) => {
      top = next;
    },
  };
}

interface DrivenWysiwygView {
  editor: Editor;
  state: () => PmEditorState;
}

function drivenWysiwygView(
  doc: PmNode,
  container: HTMLElement,
  contentTop = 2000,
): DrivenWysiwygView {
  let state = PmEditorState.create({ doc, plugins: [createLandingFlashPlugin()] });
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ top: contentTop - container.scrollTop, height: 40 }) as DOMRect;
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: ReturnType<PmEditorState['tr']['setMeta']>) {
      state = state.apply(tr);
    },
    dom: document.createElement('div'),
    nodeDOM: () => el,
    domAtPos: () => ({ node: el, offset: 0 }),
  };
  return {
    editor: { editorView: view } as unknown as Editor,
    state: () => state,
  };
}

function registerWysiwygDoc(docName: string, doc: PmNode): Editor {
  const editor = { editorView: { state: { doc } } } as unknown as Editor;
  registerEditor(docName, editor);
  return editor;
}

function cmFlashRanges(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({ from: cursor.from, to: cursor.to });
    cursor.next();
  }
  return out;
}

function markNamed(name: string): { properties?: Record<string, unknown> } | undefined {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === name);
}

describe('startSourceLanding', () => {
  const DOC = 'landing-source-doc';
  let container: HTMLElement;
  let registered: Editor | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    getCollector()?.reset();
    __resetScrollRestoreCoordination();
    clearPendingSourceNavigationsForTest();
    container = buildScrollContainer();
  });

  afterEach(() => {
    if (registered) unregisterEditor(DOC, registered);
    registered = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    container.remove();
  });

  function jumpToLastBlock(markdown: string): {
    nav: SelectionOffsetNavigation;
    ydoc: Y.Doc;
    lastBlockStart: number;
  } {
    const { doc, ydoc, ytext } = setup(markdown);
    registered = registerWysiwygDoc(DOC, doc);
    const lastIndex = doc.childCount - 1;
    const nav = present(
      buildSourceLandingNav(doc, pmPosOfBlock(doc, lastIndex), ytext, resolver, 'jump'),
    );
    return { nav, ydoc, lastBlockStart: markdown.lastIndexOf('\n\n') + 2 };
  }

  test('a landed jump flashes the resolved block range and places the caret in it', () => {
    const md = '# Title\n\nfirst para\n\ntarget para';
    const { nav, ydoc, lastBlockStart } = jumpToLastBlock(md);
    const source = drivenSourceView(md, container);

    startSourceLanding({ view: source.view, docName: DOC, navigation: nav, ydoc });

    expect(cmFlashRanges(source.state().field(landingFlashField))).toEqual([]);

    vi.advanceTimersByTime(SETTLE_QUIET_MS);

    expect(cmFlashRanges(source.state().field(landingFlashField))).toEqual([
      { from: lastBlockStart, to: md.length },
    ]);
    expect(source.state().selection.main.head).toBeGreaterThanOrEqual(lastBlockStart);
  });

  test('the flash clock starts when the landing lands, not when it was dispatched', () => {
    const md = '# Title\n\nfirst para\n\ntarget para';
    const { nav, ydoc } = jumpToLastBlock(md);
    const source = drivenSourceView(md, container);

    startSourceLanding({ view: source.view, docName: DOC, navigation: nav, ydoc });
    vi.advanceTimersByTime(SETTLE_QUIET_MS);
    expect(source.state().field(landingFlashField).size).toBe(1);

    vi.advanceTimersByTime(FLASH_DURATION_MS - 1);
    expect(source.state().field(landingFlashField).size).toBe(1);

    vi.advanceTimersByTime(1);
    expect(source.state().field(landingFlashField).size).toBe(0);
  });

  test('a plain toggle lands without flashing and without touching the selection', () => {
    const md = '# Title\n\nfirst para\n\ntarget para';
    const { doc, ydoc, ytext } = setup(md);
    registered = registerWysiwygDoc(DOC, doc);
    const nav = present(buildSourceLandingNav(doc, pmPosOfBlock(doc, 2), ytext, resolver));
    const source = drivenSourceView(md, container);

    startSourceLanding({ view: source.view, docName: DOC, navigation: nav, ydoc });
    vi.advanceTimersByTime(SETTLE_QUIET_MS);

    expect(container.scrollTop).toBe(2000 - TOOLBAR_OVERLAP_PX);
    expect(source.state().field(landingFlashField).size).toBe(0);
    expect(source.state().selection.main.head).toBe(0);
  });

  test('a jump cancelled before it settles never flashes', () => {
    const md = '# Title\n\nfirst para\n\ntarget para';
    const { nav, ydoc } = jumpToLastBlock(md);
    const source = drivenSourceView(md, container);

    const handle = startSourceLanding({
      view: source.view,
      docName: DOC,
      navigation: nav,
      ydoc,
    });
    handle?.cancel('mode-flip');

    expect(source.state().field(landingFlashField).size).toBe(0);
    vi.advanceTimersByTime(SETTLE_QUIET_MS + FLASH_DURATION_MS);
    expect(source.state().field(landingFlashField).size).toBe(0);
  });

  test('a jump that abandons never flashes', () => {
    const md = '# Title\n\nfirst para\n\ntarget para';
    const { nav, ydoc } = jumpToLastBlock(md);
    const source = drivenSourceView(md, container);

    startSourceLanding({ view: source.view, docName: DOC, navigation: nav, ydoc });

    for (let elapsed = 0; elapsed < ABANDON_WINDOW_MS; elapsed += 100) {
      source.setContentTop(elapsed % 200 === 0 ? 4000 : 2000);
      container.dispatchEvent(new Event('contentvisibilityautostatechange'));
      vi.advanceTimersByTime(100);
    }

    expect(markNamed('ok/landing/abandoned')).toBeDefined();
    expect(markNamed('ok/landing/land')).toBeUndefined();
    expect(source.state().field(landingFlashField).size).toBe(0);
  });

  test('a jump graded clamped lands but suppresses the flash', () => {
    const md = '# Title\n\nfirst para\n\ntarget para';
    const { doc, ydoc, ytext } = setup(md);
    const nav = present(buildSourceLandingNav(doc, pmPosOfBlock(doc, 2), ytext, resolver, 'jump'));

    const start = md.indexOf('target para');
    ydoc.transact(() => ytext.delete(start, ytext.length - start));
    const shrunk = ytext.toString();
    registered = registerWysiwygDoc(DOC, docFrom(shrunk));
    const source = drivenSourceView(shrunk, container);

    startSourceLanding({ view: source.view, docName: DOC, navigation: nav, ydoc });
    vi.advanceTimersByTime(SETTLE_QUIET_MS);

    expect(container.scrollTop).toBeGreaterThan(0);
    expect(source.state().field(landingFlashField).size).toBe(0);
  });

  test('does nothing when no WYSIWYG doc is mounted to grade against', () => {
    const md = '# Title\n\ntarget para';
    const { doc, ydoc, ytext } = setup(md);
    const nav = present(buildSourceLandingNav(doc, pmPosOfBlock(doc, 1), ytext, resolver, 'jump'));
    const source = drivenSourceView(md, container);

    expect(
      startSourceLanding({ view: source.view, docName: DOC, navigation: nav, ydoc }),
    ).toBeNull();
    vi.advanceTimersByTime(SETTLE_QUIET_MS);
    expect(container.scrollTop).toBe(0);
    expect(source.state().field(landingFlashField).size).toBe(0);
  });
});

describe('startWysiwygLanding', () => {
  const DOC = 'landing-wysiwyg-doc';
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    getCollector()?.reset();
    __resetScrollRestoreCoordination();
    clearPendingWysiwygNavigationsForTest();
    container = buildScrollContainer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    container.remove();
  });

  test('lands the block below the toolbar and paints no flash', () => {
    const md = '# Title\n\nfirst para\n\ntarget para';
    const { doc, ydoc, ytext, source } = setup(md);
    const nav = present(
      buildWysiwygLandingNav(source, source.indexOf('target para'), ytext, resolver, doc),
    );
    const wysiwyg = drivenWysiwygView(doc, container);
    const selectionBefore = wysiwyg.state().selection;

    startWysiwygLanding({ editor: wysiwyg.editor, docName: DOC, navigation: nav, ydoc });
    vi.advanceTimersByTime(SETTLE_QUIET_MS);

    expect(container.scrollTop).toBe(2000 - TOOLBAR_OVERLAP_PX);
    expect(landingFlashKey.getState(wysiwyg.state())?.find() ?? []).toHaveLength(0);
    expect(wysiwyg.state().selection.eq(selectionBefore)).toBe(true);
  });

  test('does nothing when the editor view is not mounted', () => {
    const md = '# Title\n\ntarget para';
    const { doc, ydoc, ytext, source } = setup(md);
    const nav = present(
      buildWysiwygLandingNav(source, source.indexOf('target para'), ytext, resolver, doc),
    );
    const editor = {} as unknown as Editor;

    expect(startWysiwygLanding({ editor, docName: DOC, navigation: nav, ydoc })).toBeNull();
    expect(container.scrollTop).toBe(0);
  });

  test('drives the visible container, not a hidden pooled one first in DOM order', () => {
    const hidden = document.createElement('div');
    hidden.setAttribute('data-testid', 'editor-scroll-container');
    Object.defineProperty(hidden, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true });
    Object.defineProperty(hidden, 'scrollHeight', { value: SCROLL_HEIGHT, configurable: true });
    Object.defineProperty(hidden, 'scrollTop', { value: 0, writable: true, configurable: true });
    hidden.getBoundingClientRect = () =>
      ({ top: 0, bottom: VIEWPORT_HEIGHT, left: 0, width: 600 }) as DOMRect;
    hidden.getClientRects = () => [] as unknown as DOMRectList;
    document.body.insertBefore(hidden, container);

    const md = '# Title\n\nfirst para\n\ntarget para';
    const { doc, ydoc, ytext, source } = setup(md);
    const nav = present(
      buildWysiwygLandingNav(source, source.indexOf('target para'), ytext, resolver, doc),
    );
    const wysiwyg = drivenWysiwygView(doc, container);

    startWysiwygLanding({ editor: wysiwyg.editor, docName: DOC, navigation: nav, ydoc });
    vi.advanceTimersByTime(SETTLE_QUIET_MS);

    expect(container.scrollTop).toBe(2000 - TOOLBAR_OVERLAP_PX);
    expect(hidden.scrollTop).toBe(0);
    hidden.remove();
  });
});
