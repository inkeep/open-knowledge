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
 * Floating-UI clipping options that keep selection-anchored menus inside the editor's visible
 * content region rather than the viewport, since the toolbar and composer overlay the container
 * without clipping it. Owns the visible-region half of precedent #35.
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

export function editorVisibleBand(editor: Editor): { top: number; bottom: number } {
  const { boundary, padding } = deriveEditorClipOptions(editor)();
  const box = boundary?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  const top = box.top + padding.top;
  return { top, bottom: Math.max(top, box.bottom - padding.bottom) };
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
