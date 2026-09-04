import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { EditorView as ProseMirrorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';
import { editorToolbarOverlapPx } from '@/lib/editor-toolbar-overlap';
import { getEditorForDoc } from './active-editor';
import { getSourceViewForDoc } from './active-source-view';
import { visibleEditorScrollContainer } from './editor-cache';
import { type LandingHandle, startLanding, type TargetMetrics } from './landing-controller';
import {
  createApproxResolver,
  type ModeSwitchPositionResolver,
  type ResolvedPosition,
} from './mode-switch-position-resolver';
import { flashSourceLanding } from './plugins/landing-flash-source';
import { registerLandingScrollOwner } from './scroll-restore-coordination';
import {
  clearPendingSourceNavigation,
  clearPendingWysiwygNavigation,
  createNavigationPin,
  peekPendingSourceNavigation,
  rememberPendingSourceNavigation,
  rememberPendingWysiwygNavigation,
  resolveNavigationPin,
  type SelectionOffsetNavigation,
} from './source-editor-navigation';
import type { EditorModeValue } from './use-editor-mode';
import { getEditorView } from './utils/get-editor-view';
import { getSharedMarkdownManager } from './utils/md-singleton';
import { VIEW_IN_SOURCE_EVENT, type ViewInSourceDetail } from './view-in-source-event';

let sharedResolver: ModeSwitchPositionResolver | null = null;
function getSharedResolver(): ModeSwitchPositionResolver {
  sharedResolver ??= createApproxResolver(getSharedMarkdownManager());
  return sharedResolver;
}

export function buildSourceLandingNav(
  doc: PmNode,
  pos: number,
  ytext: Y.Text,
  resolver: ModeSwitchPositionResolver,
  intent: 'toggle' | 'jump' = 'toggle',
): SelectionOffsetNavigation | null {
  const anchor = resolver.captureFromWysiwyg(doc, pos, { refine: intent === 'jump' });
  if (!anchor) return null;
  const resolved = resolver.resolveInSource(anchor, { source: ytext.toString(), doc });
  const pin = resolved
    ? createNavigationPin(ytext, resolved.blockStart, resolved.blockEnd)
    : undefined;
  return { kind: 'selection-offset', intent, anchor, pin };
}

export function requestViewInSource(params: {
  editor: Editor;
  docName: string;
  ytext: Y.Text;
}): void {
  const { editor, docName, ytext } = params;
  const view = getEditorView(editor);
  if (!view) return;
  const pos = view.state.selection.from;
  const nav = buildSourceLandingNav(view.state.doc, pos, ytext, getSharedResolver(), 'jump');
  if (nav) rememberPendingSourceNavigation(docName, nav);
  window.dispatchEvent(
    new CustomEvent<ViewInSourceDetail>(VIEW_IN_SOURCE_EVENT, { detail: { docName } }),
  );
}

export function buildWysiwygLandingNav(
  source: string,
  fullOffset: number,
  ytext: Y.Text,
  resolver: ModeSwitchPositionResolver,
  pmDoc: PmNode | undefined,
): SelectionOffsetNavigation | null {
  const anchor = resolver.captureFromSource(source, fullOffset);
  if (!anchor) return null;
  const sourceRange = pmDoc ? resolver.resolveInSource(anchor, { source, doc: pmDoc }) : null;
  const pin = sourceRange
    ? createNavigationPin(ytext, sourceRange.blockStart, sourceRange.blockEnd)
    : undefined;
  return { kind: 'selection-offset', anchor, pin };
}

export function resolveWysiwygLandingTarget(
  navigation: SelectionOffsetNavigation,
  ctx: { source: string; pmDoc: PmNode; ydoc: Y.Doc; resolver: ModeSwitchPositionResolver },
): ResolvedPosition | null {
  const { source, pmDoc, ydoc, resolver } = ctx;
  if (navigation.pin) {
    const live = resolveNavigationPin(navigation.pin, ydoc);
    if (live === null) {
      const resolved = resolver.resolveInWysiwyg(navigation.anchor, { source, doc: pmDoc });
      return resolved ? { ...resolved, point: resolved.blockStart, confidence: 'clamped' } : null;
    }
    const liveAnchor = resolver.captureFromSource(source, live);
    if (liveAnchor) return resolver.resolveInWysiwyg(liveAnchor, { source, doc: pmDoc });
  }
  return resolver.resolveInWysiwyg(navigation.anchor, { source, doc: pmDoc });
}

export function resolveSourceLandingTarget(
  navigation: SelectionOffsetNavigation,
  ctx: { source: string; pmDoc: PmNode; ydoc: Y.Doc; resolver: ModeSwitchPositionResolver },
): ResolvedPosition | null {
  const { source, pmDoc, ydoc, resolver } = ctx;
  if (navigation.pin) {
    const live = resolveNavigationPin(navigation.pin, ydoc);
    if (live === null) {
      const resolved = resolver.resolveInSource(navigation.anchor, { source, doc: pmDoc });
      return resolved ? { ...resolved, point: resolved.blockStart, confidence: 'clamped' } : null;
    }
    const liveAnchor = resolver.captureFromSource(source, live);
    if (liveAnchor) return resolver.resolveInSource(liveAnchor, { source, doc: pmDoc });
  }
  return resolver.resolveInSource(navigation.anchor, { source, doc: pmDoc });
}

function safeCoordsAtPos(view: EditorView, pos: number): ReturnType<EditorView['coordsAtPos']> {
  try {
    return view.coordsAtPos(pos);
  } catch {
    return null;
  }
}

export function sourceTargetMetrics(
  view: EditorView,
  container: HTMLElement,
  offset: number,
): TargetMetrics | null {
  const clamped = Math.max(0, Math.min(offset, view.state.doc.length));
  const containerTop = container.getBoundingClientRect().top;
  const coords = safeCoordsAtPos(view, clamped);
  if (coords) {
    return {
      top: coords.top - containerTop + container.scrollTop,
      height: coords.bottom - coords.top,
    };
  }
  try {
    const block = view.lineBlockAt(clamped);
    const cmDocTop = view.documentTop - containerTop + container.scrollTop;
    return { top: cmDocTop + block.top, height: block.height };
  } catch {
    return null;
  }
}

function blockElementForPos(view: ProseMirrorView, pos: number): HTMLElement | null {
  if (view.isDestroyed) return null;
  try {
    const node = view.nodeDOM(pos);
    if (node instanceof HTMLElement) return node;
    const { node: domNode } = view.domAtPos(pos);
    if (domNode instanceof HTMLElement) return domNode;
    return domNode.parentElement;
  } catch {
    return null;
  }
}

export function wysiwygTargetMetrics(
  view: ProseMirrorView,
  container: HTMLElement,
  pmPos: number,
): TargetMetrics | null {
  if (view.isDestroyed) return null;
  const clamped = Math.max(0, Math.min(pmPos, view.state.doc.content.size));
  const el = blockElementForPos(view, clamped);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const containerTop = container.getBoundingClientRect().top;
  return { top: rect.top - containerTop + container.scrollTop, height: rect.height };
}

function findScrollContainer(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return visibleEditorScrollContainer();
}

function topmostVisiblePos(view: ProseMirrorView, container: HTMLElement): number | null {
  const rect = container.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const toolbarOverlap = editorToolbarOverlapPx();
  for (const dy of [toolbarOverlap + 1, toolbarOverlap + 12, toolbarOverlap + 40]) {
    const found = view.posAtCoords({ left: x, top: rect.top + dy });
    if (found) return found.pos;
  }
  return null;
}

function topmostVisibleSourceOffset(view: EditorView, container: HTMLElement): number | null {
  const rect = container.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const toolbarOverlap = editorToolbarOverlapPx();
  for (const dy of [toolbarOverlap + 1, toolbarOverlap + 12, toolbarOverlap + 40]) {
    const pos = view.posAtCoords({ x, y: rect.top + dy });
    if (pos !== null) return pos;
  }
  return null;
}

export function captureModeSwitchAnchor(params: {
  from: EditorModeValue;
  to: EditorModeValue;
  docName: string;
  ytext: Y.Text;
}): void {
  const { from, to, docName, ytext } = params;
  if (from === 'wysiwyg' && to === 'source') captureWysiwygToSource(docName, ytext);
  else if (from === 'source' && to === 'wysiwyg') captureSourceToWysiwyg(docName, ytext);
}

function captureWysiwygToSource(docName: string, ytext: Y.Text): void {
  const existing = peekPendingSourceNavigation(docName);
  if (existing && existing.kind !== 'selection-offset') return;
  const editor = getEditorForDoc(docName);
  if (!editor) return;
  const view = getEditorView(editor);
  if (!view) return;
  const container = findScrollContainer();
  if (!container) return;
  const pos = topmostVisiblePos(view, container);
  if (pos === null) return;
  const nav = buildSourceLandingNav(view.state.doc, pos, ytext, getSharedResolver());
  if (nav) rememberPendingSourceNavigation(docName, nav);
}

function captureSourceToWysiwyg(docName: string, ytext: Y.Text): void {
  const view = getSourceViewForDoc(docName);
  if (!view) return;
  const container = findScrollContainer();
  if (!container) return;
  const offset = topmostVisibleSourceOffset(view, container);
  if (offset === null) return;
  const wysiwygEditor = getEditorForDoc(docName);
  const pmDoc = wysiwygEditor ? getEditorView(wysiwygEditor)?.state.doc : undefined;
  const nav = buildWysiwygLandingNav(ytext.toString(), offset, ytext, getSharedResolver(), pmDoc);
  if (nav) rememberPendingWysiwygNavigation(docName, nav);
}

export function startSourceLanding(params: {
  view: EditorView;
  docName: string;
  navigation: SelectionOffsetNavigation;
  ydoc: Y.Doc;
  transition?: { from: EditorModeValue; to: EditorModeValue };
}): LandingHandle | null {
  const { view, docName, navigation, ydoc, transition } = params;
  const wysiwygEditor = getEditorForDoc(docName);
  const pmDoc = wysiwygEditor ? getEditorView(wysiwygEditor)?.state.doc : undefined;
  if (!pmDoc) return null;
  const resolved = resolveSourceLandingTarget(navigation, {
    source: view.state.doc.toString(),
    pmDoc,
    ydoc,
    resolver: getSharedResolver(),
  });
  if (!resolved) return null;
  const container = findScrollContainer();
  if (!container) return null;
  const target = resolved;
  const isJump = navigation.intent === 'jump';
  const landingOffset = isJump ? target.point : target.blockStart;
  view.dispatch({ effects: EditorView.scrollIntoView(landingOffset, { y: 'start' }) });

  let cancelled = false;
  let handle: LandingHandle | null = null;
  const pendingOwner = registerLandingScrollOwner(docName, {
    yieldsToNavigation: !isJump,
    supersede: () => {
      cancelled = true;
      pendingOwner.release();
    },
  });
  const MAX_RENDER_FRAMES = 8;
  const beginWhenRendered = (attempt: number): void => {
    if (cancelled) return;
    if (safeCoordsAtPos(view, landingOffset) === null && attempt < MAX_RENDER_FRAMES) {
      requestAnimationFrame(() => beginWhenRendered(attempt + 1));
      return;
    }
    try {
      if (isJump) {
        view.dispatch({ selection: EditorSelection.cursor(landingOffset) });
        view.focus();
      }
    } finally {
      pendingOwner.release();
    }
    handle = startLanding({
      docName,
      container,
      contentColumn: view.contentDOM,
      measureTarget: () => sourceTargetMetrics(view, container, landingOffset),
      placement: isJump ? 'center' : 'top',
      intent: isJump ? 'jump' : 'toggle',
      grade: target.confidence,
      landedMode: 'source',
      transition,
      toolbarOffset: editorToolbarOverlapPx(),
      onOutcome: isJump
        ? (outcome) => {
            if (outcome.status === 'landed') {
              flashSourceLanding(view, target.blockStart, target.blockEnd, target.confidence);
            }
          }
        : undefined,
      onDiscardQueuedTarget: () => clearPendingSourceNavigation(docName),
    });
  };
  beginWhenRendered(0);
  return {
    cancel: (reason) => {
      cancelled = true;
      pendingOwner.release();
      handle?.cancel(reason);
    },
  };
}

export function startWysiwygLanding(params: {
  editor: Editor;
  docName: string;
  navigation: SelectionOffsetNavigation;
  ydoc: Y.Doc;
  transition?: { from: EditorModeValue; to: EditorModeValue };
}): LandingHandle | null {
  const { editor, docName, navigation, ydoc, transition } = params;
  const view = getEditorView(editor);
  if (!view) return null;
  const resolved = resolveWysiwygLandingTarget(navigation, {
    source: ydoc.getText('source').toString(),
    pmDoc: view.state.doc,
    ydoc,
    resolver: getSharedResolver(),
  });
  if (!resolved) return null;
  const container = findScrollContainer();
  if (!container) return null;
  const target = resolved;
  return startLanding({
    docName,
    container,
    contentColumn: view.dom,
    measureTarget: () => wysiwygTargetMetrics(view, container, target.point),
    placement: 'top',
    intent: 'toggle',
    grade: target.confidence,
    landedMode: 'wysiwyg',
    transition,
    toolbarOffset: editorToolbarOverlapPx(),
    onDiscardQueuedTarget: () => clearPendingWysiwygNavigation(docName),
  });
}
