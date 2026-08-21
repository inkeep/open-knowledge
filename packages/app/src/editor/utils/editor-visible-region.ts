import type { DetectOverflowOptions, MiddlewareState, ShiftOptions } from '@floating-ui/dom';
import type { Editor } from '@tiptap/react';
import { editorToolbarOverlapPx } from '@/lib/editor-toolbar-overlap';
import { getEditorView } from './get-editor-view';

/** Insets that shrink the editor's scroll box down to its visible region. */
interface RegionInsets {
  top: number;
  bottom: number;
}

/** The region insets plus the side gutters a clamped surface also keeps. */
interface SurfaceInsets extends RegionInsets {
  left: number;
  right: number;
}

/**
 * What `deriveEditorClipOptions` emits. `boundary` is narrowed from
 * floating-ui's `Boundary` union to the one element kind this module resolves,
 * and `padding` from `number | Partial<SideObject>` to the two insets it
 * always states — so `deriveEditorShiftOptions` can read `padding.top`
 * directly and a renamed field fails to compile instead of silently
 * forwarding nothing.
 */
type EditorClipOptions = Omit<DetectOverflowOptions, 'boundary' | 'padding'> & {
  boundary?: Element;
  padding: RegionInsets;
};

/**
 * What `deriveEditorShiftOptions` emits. `crossAxis` is stated as the literal
 * `true` rather than left as `boolean`, because dropping it is the one edit
 * that reverts this module's whole purpose: `shift()` defaults it to `false`,
 * and Y is the axis a selection scrolled behind the toolbar escapes along. As
 * a required literal, an omission is a compile error at the producer.
 */
type EditorShiftOptions = Omit<ShiftOptions, 'boundary' | 'padding' | 'mainAxis' | 'crossAxis'> & {
  boundary?: Element;
  mainAxis: true;
  crossAxis: true;
  padding: SurfaceInsets;
};

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
 * it, so the two producers are consumed together.
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
    // `getEditorView` rather than `editor.view`, which is a proxy that throws
    // until the ProseMirror view mounts (recycle/remount race). A try/catch
    // around that throw swallows every other one too, and a missing boundary
    // is invisible: the clamp quietly falls back to the viewport.
    const boundary = getEditorView(editor)?.dom.closest('.editor-doc-scroll') ?? null;
    const padding = {
      top: editorToolbarOverlapPx(),
      bottom:
        readRootInlinePxVar('--ask-composer-height') +
        readRootInlinePxVar('--conflict-footer-height'),
    };
    // No resolvable scroll container (detached view, non-doc host): fall back
    // to floating-ui's default boundary rather than pinning a stale element.
    return boundary ? { boundary, padding } : { padding };
  };
}

/** Gap a selection-anchored surface keeps between itself and its anchor. */
export const SELECTION_SURFACE_GAP_PX = 8;

/** Gutter a selection-anchored surface keeps from the pane's left/right edges. */
const PANE_GUTTER_PX = 8;

/**
 * The enforcement half of the contract `deriveEditorClipOptions` describes:
 * `shift()` options that clamp a surface into the editor's visible content
 * region on BOTH axes.
 *
 * The load-bearing option is `crossAxis`. For a `top`/`bottom` placement
 * shift's main axis is X and its cross axis is Y, and `crossAxis` defaults to
 * `false` — which is why supplying the boundary alone never kept a surface
 * inside the region it describes. Y is the axis a selection scrolled behind
 * the toolbar escapes along.
 *
 * `pendingOffsetPx` is the anchor gap that `offset()` will still apply AFTER
 * this clamp. It is zero when `offset()` runs first (floating-ui's documented
 * ordering, which the middleware arrays we assemble ourselves follow) and the
 * gap size only for tiptap's BubbleMenu plugin, which builds its own array as
 * `flip -> shift -> offset` and gives us no way to reorder it. Shifting the
 * clamp region by that pending delta makes both writers settle on the same
 * coordinate FOR THE SAME PLACEMENT; that equality is what
 * `selection-surface-pane-clip.e2e.ts` asserts directly, so a tiptap release
 * that adopted floating-ui's documented order would fail there by name rather
 * than drift in the product.
 *
 * The compensation does not extend to `flip`, which is not passed one:
 * `detectOverflow` measures the floating rect at its CURRENT coordinates, so
 * the loop's `flip` (after `offset`) sees a rect one gap further from the
 * anchor than the plugin's (before `offset`). Inside that one-gap band of
 * anchor positions the two writers can still choose different placements, and
 * the bar reads as jumping from above the selection to below it. Both results
 * stay inside the region, so containment is unaffected.
 *
 * Chain order has to be known statically here: `computePosition` never clears
 * `middlewareData` across a `flip()` reset, so sniffing for
 * `middlewareData.offset` reads pass-1 data on pass 2.
 */
export function deriveEditorShiftOptions(
  editor: Editor,
  { pendingOffsetPx = 0 }: { pendingOffsetPx?: number } = {},
): (state: Pick<MiddlewareState, 'placement'>) => EditorShiftOptions {
  const clip = deriveEditorClipOptions(editor);
  return (state) => {
    const { padding, ...boundaryOptions } = clip();
    const side = state.placement.split('-')[0];
    // A top-side surface is pushed further up by the pending gap and a
    // bottom-side one further down; for left/right placements the gap is
    // horizontal and there is no pending Y delta to absorb.
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
