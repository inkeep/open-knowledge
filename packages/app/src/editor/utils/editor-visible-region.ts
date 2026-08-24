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
 * What `deriveEditorSizeOptions` emits. `apply` states only the one field it
 * reads instead of floating-ui's full `MiddlewareState & { availableWidth,
 * availableHeight }`: the producer derives its cap from the region itself, and
 * narrowing the parameter is what makes reaching for `availableWidth` — the
 * position-dependent number this deliberately does not use — a compile error
 * rather than a silent behaviour change. A handler that accepts less is still
 * assignable where floating-ui passes more.
 *
 * No `boundary`/`padding` here: `size()`'s own `detectOverflow` pass feeds
 * numbers we ignore, so stating a boundary for it would advertise an input
 * this producer does not consume.
 */
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
        readRootInlinePxVar('--ask-composer-height') +
        readRootInlinePxVar('--conflict-footer-height'),
    };
    // No resolvable scroll container (detached view, non-doc host): fall back
    // to floating-ui's default boundary rather than pinning a stale element.
    return boundary ? { boundary, padding } : { padding };
  };
}

/**
 * The editor's scroll box — the element every producer here bounds against.
 *
 * `getEditorView` rather than `editor.view`, which is a proxy that throws
 * until the ProseMirror view mounts (recycle/remount race). A try/catch around
 * that throw swallows every other one too, and a missing boundary is
 * invisible: the clamp quietly falls back to the viewport.
 */
function resolveRegionBoundary(editor: Editor): Element | null {
  return getEditorView(editor)?.dom.closest('.editor-doc-scroll') ?? null;
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
 * The third member of the contract: a cap that keeps a surface NARROWER than
 * the editor's visible content region.
 *
 * `shift()` relocates; it cannot shrink. Its clamp can satisfy both pane edges
 * only while the surface FITS between them, so a surface with a fixed width —
 * the formatting bar is ~450px, the comment composer's card 320px, the lint
 * callout 352px — overhangs a pane narrower than itself from every coordinate
 * the clamp could choose. Docking the terminal to the right of a narrowed
 * editor column is how that happens in the product: the surplus paints on the
 * terminal — the same escape the two producers above close for position
 * alone.
 *
 * The cap is measured off the boundary element rather than read from
 * floating-ui's `availableWidth`, and that is deliberate. `availableWidth` is
 * position-dependent until `shift()` has run — while `middlewareData.shift` is
 * absent floating-ui reports `min(overflowAvailableWidth,
 * maximumClippingWidth)`, the room to the right of wherever the surface
 * currently sits — so a chain that sized before it clamped would squeeze a
 * surface in a pane with room to spare. Measuring the region states the
 * invariant the product wants (a surface is at most as wide as the pane it
 * belongs to) and makes this producer correct at ANY index in the middleware
 * array. That matters because we do not own every array: tiptap's BubbleMenu
 * plugin assembles its own as `flip -> shift -> offset -> arrow -> size ->
 * hide` and gives us no way to reorder it.
 *
 * `size()` re-runs the chain whenever `apply` changed the surface's
 * dimensions, so `shift()` re-clamps against the narrowed rect rather than the
 * one it was about to overflow with.
 *
 * `authorMaxWidth` is for a surface whose stylesheet ALREADY caps its width —
 * the lint callout's `22rem`. An inline `max-width` outranks that rule, so
 * writing the region width bare would WIDEN such a surface on a roomy pane
 * instead of only narrowing it on a cramped one. Naming the author's cap here
 * folds the two into `min()` and keeps this producer a ceiling, never a floor.
 * A surface with no stylesheet cap (the bar) or one that sets `width` rather
 * than `max-width` (the comment card's `w-80`, which `max-width` already
 * beats) omits it.
 *
 * No resolvable region (detached view, non-doc host): clear the cap rather
 * than pin the surface to a stale width. The same fallback the other two
 * producers take.
 */
export function deriveEditorSizeOptions(
  editor: Editor,
  { authorMaxWidth }: { authorMaxWidth?: string } = {},
): () => EditorSizeOptions {
  return () => ({
    apply({ elements }) {
      const boundary = resolveRegionBoundary(editor);
      if (!boundary) {
        elements.floating.style.maxWidth = '';
        return;
      }
      const regionWidth = Math.max(0, boundary.getBoundingClientRect().width - PANE_GUTTER_PX * 2);
      elements.floating.style.maxWidth = authorMaxWidth
        ? `min(${authorMaxWidth}, ${regionWidth}px)`
        : `${regionWidth}px`;
    },
  });
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
