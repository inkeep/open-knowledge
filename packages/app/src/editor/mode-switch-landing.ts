/**
 * Wires the mode-switch position resolver, the pending-navigation stores, and
 * the landing controller into an actual "flip mode, then keep my place" toggle.
 *
 * Two halves that meet through the pending-navigation store:
 *
 *   - CAPTURE runs at flip time, while the outgoing editor is still laid out.
 *     It reads the topmost visible block, turns it into a resolver anchor plus a
 *     relative-position pin over the corresponding source range, and banks that
 *     as a pending navigation for the incoming view to replay.
 *   - DISPATCH runs when the incoming view is mounted and active. It resolves
 *     the anchor against the live document, reconciles it with the pin (so a
 *     remote edit in the capture-to-dispatch window moves the target with the
 *     content), and hands a measured target to the landing controller.
 *
 * Everything cross-representation goes through `ModeSwitchPositionResolver`, so
 * no coordinate logic lives here beyond turning a CodeMirror offset into the
 * scroll-content geometry the controller measures against. Navigation is
 * read-only: nothing here mutates a Y.Text, a fragment, or a selection.
 */

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { EditorView as ProseMirrorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';
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

// Toolbar exclusion zone in px (= EditorToolbar's rendered 3.5rem height). The
// toolbar overlays the top of the shared scroller, so both the capture probe
// (below the toolbar) and the landing offset (target sits just under it) start
// here. Restated rather than shared to keep this leaf free of a React-component
// import cycle; keep in sync with TOOLBAR_OVERLAP_PX in SourceEditor.tsx and the
// scroll-pt-14 in components/EditorActivityPool.tsx.
const TOOLBAR_OVERLAP_PX = 56;

let sharedResolver: ModeSwitchPositionResolver | null = null;
function getSharedResolver(): ModeSwitchPositionResolver {
  sharedResolver ??= createApproxResolver(getSharedMarkdownManager());
  return sharedResolver;
}

/**
 * Build the source-destined pending navigation for a WYSIWYG-to-source flip: the
 * block anchor under `pos` plus a pin over its source range so a queued landing
 * tracks remote edits. Null when there is no anchor to capture (empty doc), which
 * reproduces the pre-feature no-op flip. The pin is omitted when the block has no
 * source counterpart (a body with no top-level blocks); the ordinal still lands.
 *
 * A `jump` intent additionally refines the anchor to the caret's inline offset,
 * so an `exact` landing can place the caret inside the block rather than only at
 * its start; a `toggle` captures the block alone and stays scroll-only.
 */
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

/**
 * Bank an explicit "view in source" jump for the WYSIWYG caret and ask the pane
 * to flip to source. The landing target is stored before the flip so the
 * incoming source view replays it; the flip itself is left to `EditorPane` via
 * the window event, which owns the mode state — the same split the raw-MDX
 * navigation uses. The switch fires even for an empty document (no block to
 * bank) so the user always reaches source mode.
 *
 * The caret is the only input: every entry point (bubble button, keyboard
 * command, desktop context menu) acts on the selection the user already has.
 * The desktop menu therefore lands on the block under the pointer only because
 * Chromium moves the caret when you right-click editable text — nothing here
 * records the pointer, and a caller that needs a pointer-anchored jump has to
 * carry the coordinates through rather than assume this reads them.
 */
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

/**
 * Build the WYSIWYG-destined pending navigation for a source-to-WYSIWYG flip: the
 * block anchor for `fullOffset` (the topmost visible source line's char offset)
 * plus a pin over that block's source range so a queued landing tracks remote
 * edits. Both directions pin the source range because `Y.Text('source')` is the
 * document's truth. Null when there is no anchor to capture (empty body), which
 * reproduces the pre-feature no-op flip. The pin is omitted when the WYSIWYG doc
 * is not mounted to derive the source range against (a large doc that deferred
 * it); the ordinal still lands.
 */
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

/**
 * Resolve a queued WYSIWYG landing against the live document. Mirrors the
 * source-side resolve: a surviving pin re-anchors on its live source offset so a
 * remotely-moved block is followed; a pin that can no longer resolve degrades to
 * a clamped block-start; a pinless navigation rides the ordinal. The returned
 * positions are ProseMirror positions. Null when the doc has no block to land on.
 */
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

/**
 * Resolve a queued source landing against the live document. The pin is
 * authoritative when it survives: re-anchoring on its live offset follows a
 * block that remote edits moved during the capture-to-dispatch window. A pin
 * that can no longer resolve means the captured block was deleted, so the
 * landing degrades to a clamped block-start rather than trusting an ordinal that
 * now points at unrelated content. Null when the body has no blocks to land on.
 */
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

/**
 * Measured coordinates of a CodeMirror offset, or null when the view cannot
 * answer. A landing outlives a single frame, so its measurer can be called after
 * the view it closed over was torn down or recycled — CodeMirror drops its
 * document view on destroy and then throws out of the geometry accessors rather
 * than returning null (it exposes no public destroyed predicate to pre-check).
 * A landing has to degrade to "not measurable yet" there, never propagate a
 * throw into the controller's terminal paths, where it would strand their holds.
 */
function safeCoordsAtPos(view: EditorView, pos: number): ReturnType<EditorView['coordsAtPos']> {
  try {
    return view.coordsAtPos(pos);
  } catch {
    return null;
  }
}

/**
 * Scroll-content geometry of a CodeMirror offset, in the shared scroller's
 * coordinate space. `coordsAtPos` returns the target line's measured rect once it
 * is rendered, which is authoritative; the settle loop converges on it. The
 * height map (`lineBlockAt`) estimates off-viewport lines from a gap average, and
 * those estimates never refine for lines above a downward scroll, so trusting it
 * lands on the estimate and stays there — it is used only as a bootstrap to move
 * the scroller near the target, which renders it so the measured branch takes
 * over. Null when the view is gone (see `safeCoordsAtPos`).
 */
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
  // Same teardown exposure as `safeCoordsAtPos`: the height map is gone with the
  // document view, so a torn-down view throws here too.
  try {
    const block = view.lineBlockAt(clamped);
    const cmDocTop = view.documentTop - containerTop + container.scrollTop;
    return { top: cmDocTop + block.top, height: block.height };
  } catch {
    return null;
  }
}

/**
 * The top-level block element containing a ProseMirror position, or null — which
 * includes the case where the view was destroyed or the position no longer
 * resolves against it, since both throw out of the DOM accessors.
 */
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

/**
 * Scroll-content geometry of a ProseMirror position, in the shared scroller's
 * coordinate space. The top-level block element carries the content-visibility
 * box, so its `getBoundingClientRect` is laid out from the intrinsic-size
 * estimate even while the block's contents are render-skipped — the settle loop
 * re-measures as blocks above it materialize and the estimate refines, so no
 * virtualization-aware prime is needed (unlike the source path, where an
 * off-viewport line has no DOM at all). Null when the position resolves to no
 * element, e.g. while the incoming editor is still mounting.
 */
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
  // A backgrounded pooled doc keeps its scroll container in the DOM (a hidden
  // <Activity> is display:none, not unmounted), so a plain first-match query can
  // return a container the user cannot see. The visible-container helper filters
  // by client rects so a landing always measures and scrolls the active one.
  return visibleEditorScrollContainer();
}

/**
 * PM position of the topmost visible content, probed just under the toolbar and
 * stepped down a little to clear the margin between blocks. Null when no probe
 * lands on content (e.g. the scroller sits below all content), so the caller
 * leaves the flip a no-op.
 */
function topmostVisiblePos(view: ProseMirrorView, container: HTMLElement): number | null {
  const rect = container.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  for (const dy of [TOOLBAR_OVERLAP_PX + 1, TOOLBAR_OVERLAP_PX + 12, TOOLBAR_OVERLAP_PX + 40]) {
    const found = view.posAtCoords({ left: x, top: rect.top + dy });
    if (found) return found.pos;
  }
  return null;
}

/**
 * Full `Y.Text` offset of the topmost visible source line, probed just under the
 * toolbar and stepped down to clear the inter-line margin. Null when no probe
 * lands on a line (the scroller sits below all content), so the caller leaves
 * the flip a no-op.
 */
function topmostVisibleSourceOffset(view: EditorView, container: HTMLElement): number | null {
  const rect = container.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  for (const dy of [TOOLBAR_OVERLAP_PX + 1, TOOLBAR_OVERLAP_PX + 12, TOOLBAR_OVERLAP_PX + 40]) {
    const pos = view.posAtCoords({ x, y: rect.top + dy });
    if (pos !== null) return pos;
  }
  return null;
}

/**
 * Capture the viewport anchor for a mode flip and bank it for the incoming view.
 * Runs synchronously at flip time, before the outgoing editor is hidden, so the
 * geometry it reads is the one the user is looking at. A tool-driven flip that
 * already queued its own target (a raw-MDX jump) is left untouched — the toggle
 * yields rather than overwriting it.
 */
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
  // The WYSIWYG doc — mounted CSS-hidden underneath source mode — supplies the
  // source range for the pin. Absent for a large doc that deferred it; the
  // ordinal then lands pinless.
  const wysiwygEditor = getEditorForDoc(docName);
  const pmDoc = wysiwygEditor ? getEditorView(wysiwygEditor)?.state.doc : undefined;
  const nav = buildWysiwygLandingNav(ytext.toString(), offset, ytext, getSharedResolver(), pmDoc);
  if (nav) rememberPendingWysiwygNavigation(docName, nav);
}

/**
 * Start the source-side landing for a replayed selection-offset navigation. The
 * WYSIWYG doc supplies the count tripwire the resolver grades on; when it is not
 * mounted (a large doc that deferred it) the landing degrades to today's no-op
 * rather than grading blind.
 *
 * A `toggle` intent preserves the topmost block at the toolbar edge and never
 * touches the selection. A `jump` intent centers the block, places the caret at
 * its resolved point (refined inline only at `exact`), and flashes the block once
 * it lands on screen — the explicit "view in source" behavior. Returns the
 * controller handle so the caller can cancel it if the mode flips away before it
 * settles, or null when there is nothing to land on.
 */
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
  // A jump lands (and places the caret) at the resolved point; a toggle preserves
  // the block from its start.
  const landingOffset = isJump ? target.point : target.blockStart;
  // Prime CodeMirror's own virtualization-aware scroll so the target line renders
  // and its measured rect drives the settle. The prime is scroll-only; a jump's
  // caret and focus come after the line renders, below. `y: 'start'` is the only
  // alignment that propagates to the ancestor scrollport in full-page source mode.
  view.dispatch({ effects: EditorView.scrollIntoView(landingOffset, { y: 'start' }) });

  // The prime applies on CodeMirror's next measure, so the target line is not
  // rendered yet this frame and `coordsAtPos` returns null. Starting the settle
  // now would make its first measure fall back to the over-tall off-viewport
  // estimate and overshoot, and the source path has no content-resize or
  // content-visibility signal to correct it afterward. Wait (bounded) for the
  // primed scroll to render the line so the settle's first measure is the real
  // rect. The returned handle cancels the deferred start if the mode flips away
  // before it begins.
  let cancelled = false;
  let handle: LandingHandle | null = null;
  // The render-wait belongs to the landing's ownership window too. Without a
  // registration covering it, an explicit navigation arriving in these frames
  // would scroll, see no owner to pre-empt, and then be overwritten by the
  // controller a frame later — the same erasure, just earlier.
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
        // Place the caret at the landed point so the user can edit immediately.
        // Selection-only (no `scrollIntoView`): the controller owns scroll for the
        // whole settle window, so this cannot fight it. This is the one selection
        // write the feature makes — exclusive to the explicit jump.
        view.dispatch({ selection: EditorSelection.cursor(landingOffset) });
        view.focus();
      }
    } finally {
      pendingOwner.release(); // the controller registers its own for the settle
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
      toolbarOffset: TOOLBAR_OVERLAP_PX,
      onOutcome: isJump
        ? (outcome) => {
            // Flash the whole block once it is genuinely on screen (the controller
            // landed it), so the highlight's 2s clock measures visible time. A
            // clamped or unverified ordinal grade self-suppresses inside
            // `flashSourceLanding`.
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

/**
 * Start the WYSIWYG-side landing for a replayed selection-offset navigation. The
 * target block element carries a laid-out content-visibility box even while
 * off-viewport, so its geometry is measurable immediately and the settle loop
 * converges as the estimate refines — no virtualization-aware prime and no
 * render-wait are needed (the source path needs both because an off-viewport CM
 * line has no DOM). Scroll-only: no selection, focus, or flash change, so the
 * plain toggle stays non-interfering. Returns the controller handle so the
 * caller can cancel it if the mode flips away before it settles, or null when
 * the editor is unmounted or there is nothing to land on.
 */
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
    toolbarOffset: TOOLBAR_OVERLAP_PX,
    onDiscardQueuedTarget: () => clearPendingWysiwygNavigation(docName),
  });
}
