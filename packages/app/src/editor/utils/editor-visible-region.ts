import type { DetectOverflowOptions, MiddlewareState, ShiftOptions } from '@floating-ui/dom';
import type { Editor } from '@tiptap/react';
import { editorToolbarOverlapPx } from '@/lib/editor-toolbar-overlap';
import { getEditorView } from './get-editor-view';

interface RegionInsets {
  top: number;
  bottom: number;
}

interface SurfaceInsets extends RegionInsets {
  left: number;
  right: number;
}

type EditorClipOptions = Omit<DetectOverflowOptions, 'boundary' | 'padding'> & {
  boundary?: Element;
  padding: RegionInsets;
};

type EditorShiftOptions = Omit<ShiftOptions, 'boundary' | 'padding' | 'mainAxis' | 'crossAxis'> & {
  boundary?: Element;
  mainAxis: true;
  crossAxis: true;
  padding: SurfaceInsets;
};

interface EditorSizeOptions {
  apply: (state: Pick<MiddlewareState, 'elements'>) => void;
}

/**
 * Floating-UI clipping options that keep selection-anchored menus inside the
 * editor's *visible* content region, not just inside the viewport.
 *
 * `.editor-doc-scroll` clips the document, but the region where a selection
 * actually reads as visible is smaller than the container's box: the
 * EditorToolbar overlays the container's top exclusion zone, and the Ask AI
 * bottom composer (stacked above the conflict-resolution footer when one is
 * up) floats over the container's bottom edge. None of these are clipping
 * ancestors, so a body-appended `position: fixed` bubble menu keeps tracking
 * a selection that has scrolled behind them — sliding over the composer card
 * and the status footer below the container.
 *
 * Pass the result to `flip()` so placement decisions stay inside the visible
 * region, to `hide()` (default strategy `referenceHidden`) so the menu
 * disappears once the selection itself is fully occluded — matching what the
 * user can see rather than what the DOM clips — and to
 * `deriveEditorShiftOptions` below, which converts this description of the
 * region into the clamp that keeps a surface inside it. A boundary handed to
 * `flip()`/`hide()` alone detects the overflow and then declines to correct
 * it, so the producers are consumed together — and where the surface can be
 * wider than the pane, with `deriveEditorSizeOptions` as well, since the
 * clamp has nowhere to put a surface that does not fit.
 *
 * Floating UI is the canonical positioning primitive for selection-anchored
 * overlays (precedent #35), and this module owns the visible-region half of
 * that contract for any surface anchored inside the editor's scrollable
 * content. It lives under `editor/utils/` rather than beside any one consumer
 * because comments, menus, suggestions, and lint surfaces all read it.
 *
 * Shaped as a floating-ui derivable (re-evaluated on every `computePosition`
 * pass) because the composer publishes a live height — its card grows with
 * the draft and collapses to nothing — and the scroll container can be
 * remounted across document switches.
 */
export function deriveEditorClipOptions(editor: Editor): () => EditorClipOptions {
  return () => {
    const boundary = resolveRegionBoundary(editor);
    const padding = {
      top: editorToolbarOverlapPx(),
      bottom:
        readRootInlinePxVar(ASK_COMPOSER_HEIGHT_VAR) +
        readRootInlinePxVar('--conflict-footer-height'),
    };
    return boundary ? { boundary, padding } : { padding };
  };
}

function resolveRegionBoundary(editor: Editor): Element | null {
  return getEditorView(editor)?.dom.closest('.editor-doc-scroll') ?? null;
}

export const SELECTION_SURFACE_GAP_PX = 8;

const PANE_GUTTER_PX = 8;

export function deriveEditorShiftOptions(
  editor: Editor,
  { pendingOffsetPx = 0 }: { pendingOffsetPx?: number } = {},
): (state: Pick<MiddlewareState, 'placement'>) => EditorShiftOptions {
  const clip = deriveEditorClipOptions(editor);
  return (state) => {
    const { padding, ...boundaryOptions } = clip();
    const side = state.placement.split('-')[0];
    const pendingY = side === 'top' ? -pendingOffsetPx : side === 'bottom' ? pendingOffsetPx : 0;
    return {
      ...boundaryOptions,
      mainAxis: true,
      crossAxis: true,
      padding: {
        top: padding.top - pendingY,
        bottom: padding.bottom + pendingY,
        left: PANE_GUTTER_PX,
        right: PANE_GUTTER_PX,
      },
    };
  };
}

export function deriveEditorSizeOptions(
  editor: Editor,
  { authorMaxWidth }: { authorMaxWidth?: string } = {},
): () => EditorSizeOptions {
  return () => ({
    apply({ elements }) {
      const regionWidth = editorRegionWidthPx(editor);
      if (regionWidth === null) {
        elements.floating.style.maxWidth = '';
        return;
      }
      elements.floating.style.maxWidth = authorMaxWidth
        ? `min(${authorMaxWidth}, ${regionWidth}px)`
        : `${regionWidth}px`;
    },
  });
}

export function editorRegionWidthPx(editor: Editor): number | null {
  const boundary = resolveRegionBoundary(editor);
  if (!boundary) return null;
  return Math.max(0, boundary.getBoundingClientRect().width - PANE_GUTTER_PX * 2);
}

export const ASK_COMPOSER_HEIGHT_VAR = '--ask-composer-height';

function readRootInlinePxVar(name: string): number {
  const value = Number.parseFloat(document.documentElement.style.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}
