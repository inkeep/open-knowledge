import type { Editor } from '@tiptap/react';
import { TOOLBAR_HEIGHT } from '../extensions/frozen-table-headers';

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
 * region, and to `hide()` (default strategy `referenceHidden`) so the menu
 * disappears once the selection itself is fully occluded — matching what the
 * user can see rather than what the DOM clips.
 *
 * Shaped as a floating-ui derivable (re-evaluated on every `computePosition`
 * pass) because the composer publishes a live height — its card grows with
 * the draft and collapses to nothing — and the scroll container can be
 * remounted across document switches.
 */
export function deriveEditorClipOptions(editor: Editor) {
  return () => {
    let boundary: Element | null = null;
    try {
      boundary = editor.view.dom.closest('.editor-doc-scroll');
    } catch {
      // `editor.view` is a throwing proxy until the ProseMirror view mounts
      // (recycle/remount race) — fall back to the default boundary this pass.
    }
    const padding = {
      top: TOOLBAR_HEIGHT,
      bottom:
        readRootInlinePxVar('--ask-composer-height') +
        readRootInlinePxVar('--conflict-footer-height'),
    };
    // No resolvable scroll container (detached view, non-doc host): fall back
    // to floating-ui's default boundary rather than pinning a stale element.
    return boundary ? { boundary, padding } : { padding };
  };
}

/**
 * Both overlay heights are published as inline styles on the document root
 * (BottomComposer and use-conflict-footer-height.ts), so read the inline
 * declaration directly instead of paying a `getComputedStyle` resolution on
 * every scroll tick. Absent (overlay closed) or malformed values read as 0.
 */
function readRootInlinePxVar(name: string): number {
  const value = Number.parseFloat(document.documentElement.style.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}
