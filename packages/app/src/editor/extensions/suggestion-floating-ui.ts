import type { MiddlewareState } from '@floating-ui/dom';
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import type { Editor } from '@tiptap/core';
import type { SuggestionProps } from '@tiptap/suggestion';
import {
  deriveEditorClipOptions,
  deriveEditorShiftOptions,
  deriveEditorSizeOptions,
  editorRegionWidthPx,
} from '@/editor/utils/editor-visible-region';

export interface SuggestionPositionState {
  popup: HTMLDivElement | null;
  stopAutoUpdate: (() => void) | null;
}

/**
 * Gap a suggestion picker keeps from its caret, in both the document editor and
 * the composers. Independent of the visible-region contract: the clamp works at
 * any gap, so this stays at the value the pickers have always used rather than
 * harmonising with the bubble bar's.
 */
const SUGGESTION_ANCHOR_GAP_PX = 4;

/**
 * How many selectable items the currently-open suggestion picker holds, keyed
 * by the ProseMirror view it is attached to. The COMPOSER pickers (`@` and
 * `/`) publish this so the composer's Enter guard can defer to the picker only
 * when there is something to commit: the suggestion plugin's `active` state is
 * regex-derived and stays true over an EMPTY result list, and a deferred Enter
 * with nothing to select falls through to TipTap's core `splitBlock` — the
 * user reads "press Enter to send", presses it, and gets a blank line instead.
 * At most one picker is open per view (distinct trigger chars), so a single
 * slot per view suffices. Document-editor pickers don't publish: their Enter
 * fallthrough is a real newline, which is correct there.
 */
const suggestionSelectableCounts = new WeakMap<object, number>();

export function setSuggestionSelectableCount(view: object, count: number): void {
  suggestionSelectableCounts.set(view, count);
}

export function clearSuggestionSelectableCount(view: object): void {
  suggestionSelectableCounts.delete(view);
}

/** True when the open picker on this view has at least one selectable item. */
export function suggestionHasSelectableItem(view: object): boolean {
  return (suggestionSelectableCounts.get(view) ?? 0) > 0;
}

/**
 * The picker's middleware chain.
 *
 * Without an `editor` this is the window-relative chain: `flip`/`shift` fall
 * back to floating-ui's clipping ancestors, and `size` caps the list at 40vh.
 * With one, all three take the editor's visible content region instead, so a
 * ~490px picker opened past the middle of the prose column stops sliding over
 * whatever sits in the rail beside the pane.
 *
 * `size` sits BEFORE `shift`, which is the reverse of floating-ui's usual
 * advice and is load-bearing here. `size` measures the floating rect where it
 * currently is; run after the clamp it sees a box the clamp has already pushed
 * inside the region, reports no overflow, and never shrinks anything — leaving
 * a full-height picker parked over the caret line whenever the caret sits too
 * far from both region edges to host one. Run before the clamp it measures the
 * ideal placement, caps the list at the room actually available beside the
 * anchor, and leaves the clamp with nothing to do.
 */
/**
 * Width below which the picker drops to one column.
 *
 * The slash menu is a `w-56` list beside a `w-64` preview with a `gap-2`
 * between them — 488px of fixed columns. A pane that cannot hold both squeezes
 * BOTH, and a half-width list beside a sliver of preview reads worse than the
 * list alone. The preview is `aria-hidden` decoration, so dropping it costs
 * nothing a screen reader was getting.
 */
const SUGGESTION_TWO_COLUMN_MIN_PX = 488;

function buildMiddleware(popup: HTMLDivElement, editor: Editor | undefined) {
  const applySize = {
    apply({ availableHeight }: { availableHeight: number }) {
      if (popup.isConnected) {
        popup.style.setProperty(
          '--suggestion-menu-max-height',
          `${Math.min(availableHeight, window.innerHeight * 0.4)}px`,
        );
      }
    },
  };
  if (!editor) {
    return [
      offset(SUGGESTION_ANCHOR_GAP_PX),
      flip(),
      // Keep the popup inside the viewport when its width pushes past the
      // right edge — required since the slash-menu preview panel widened the
      // popup to ~490px, where right-half cursor positions or narrow viewports
      // would otherwise clip the preview.
      shift({ padding: 8 }),
      size(applySize),
    ];
  }
  const clipOptions = deriveEditorClipOptions(editor);
  const capWidth = deriveEditorSizeOptions(editor);
  return [
    offset(SUGGESTION_ANCHOR_GAP_PX),
    flip(clipOptions),
    // The width cap rides the EXISTING `size` rather than a second one, and
    // this call keeps its place BEFORE the clamp. That position is load-bearing
    // for the height half above (see this function's docstring) and the cap is
    // indifferent to it: `deriveEditorSizeOptions` measures the region instead
    // of reading floating-ui's position-dependent `availableWidth`, so it is
    // correct wherever in the chain it runs.
    size(() => {
      const { apply: applyWidthCap } = capWidth();
      // Read BEFORE the two `apply`s below write styles. `applyWidthCap` reads
      // the region again internally, which is deliberate — `editorRegionWidthPx`
      // exists so a caller needing the number does not become a second
      // definition of the region — so this neither makes the pass single-read
      // nor removes every post-write read: `size` re-enters with
      // `reset: { rects: true }` when it changed the surface, and that pass
      // measures again. What it buys is the column decision no longer being
      // one of the reads that follows a write.
      const regionWidth = editorRegionWidthPx(editor);
      return {
        ...clipOptions(),
        apply(state: MiddlewareState & { availableHeight: number }) {
          applyWidthCap(state);
          applySize.apply(state);
          applyColumnCount(popup, regionWidth);
        },
      };
    }),
    shift(deriveEditorShiftOptions(editor)),
  ];
}

/**
 * Mark the popup one-column when the region cannot hold both of its columns.
 *
 * A `data-` attribute plus a CSS rule rather than React state: the menus are
 * rendered into this popup by three different components, the decision is a
 * pure function of a width the positioning pass already measured, and routing
 * it back through React would re-render the list on every scroll tick. No
 * resolvable region leaves the attribute alone — same fallback as the cap.
 */
function applyColumnCount(popup: HTMLDivElement, regionWidth: number | null): void {
  if (!popup.isConnected || regionWidth === null) return;
  popup.toggleAttribute('data-suggestion-narrow', regionWidth < SUGGESTION_TWO_COLUMN_MIN_PX);
}

/**
 * Create a positioned suggestion popup element and its positioning helpers.
 * Shared by slash-command and wiki-link suggestion menus.
 *
 * Returns: { popup, doPosition, startAutoUpdate, reveal }
 * - popup: the positioned container element (fixed, z-50, appended to body).
 *   Starts with `visibility: hidden` — caller must call `reveal()` once content
 *   is ready and stable. This prevents the "flash at wrong position" artifact
 *   when the popup is placed before its final content is rendered.
 * - doPosition: trigger repositioning (call after content changes in onStart
 *   and onUpdate)
 * - startAutoUpdate: call AFTER appending renderer content to preserve
 *   content-before-autoUpdate ordering (autoUpdate fires doPosition
 *   synchronously on setup — must run after popup has content so
 *   flip/placement middleware see the populated element's dimensions,
 *   not an empty container's)
 * - reveal: makes the popup visible after the next computePosition resolves.
 *   For sync menus (slash-command), call immediately after startAutoUpdate.
 *   For async menus (wiki-link), defer until items have loaded (in onStart)
 *   so flip() sees the populated content's dimensions, not the loading state's.
 *
 * Uses `popup.isConnected` guards in async callbacks because computePosition
 * is async (returns Promise). The `.then()` can resolve after cleanup has
 * called `popup.remove()` — at that point the reference is non-null but
 * disconnected. A null-check alone would miss this race.
 *
 * `clipToEditorPane` opts a picker into the editor's visible-region contract:
 * the caret it tracks lives in the document's scroll container, so the picker
 * belongs inside that container's visible box rather than merely inside the
 * window. It is opt-in rather than derived because this factory also serves the
 * COMPOSER pickers, whose caret sits in the Ask AI / comment composer — a
 * surface that legitimately floats outside the document pane, and would be
 * clamped into it by a blanket application.
 */
export function createSuggestionPopup(
  getCurrentProps: () => SuggestionProps<unknown> | null,
  label: string,
  { clipToEditorPane = false }: { clipToEditorPane?: boolean } = {},
): {
  popup: HTMLDivElement;
  doPosition: () => void;
  startAutoUpdate: () => () => void;
  reveal: () => void;
} {
  const popup = document.createElement('div');
  // Identifies every suggestion popup as one, from outside the editor. They are
  // portaled to `document.body`, so a host that dismisses on outside-click — the
  // comment composer — would otherwise read a click on `@`-mention results as a
  // click away and close itself mid-pick.
  popup.dataset.suggestionPopup = label;
  // Marks the popups whose width the editor region caps, and is what the
  // `globals.css` rule hangs the shrink-propagation off. The cap is a
  // `max-width` on THIS wrapper, and a `max-width` does not shrink a block
  // child that carries its own fixed `width` — so a menu root at `w-80` sat
  // inside a 284px wrapper and painted 320px anyway. Making the popup's
  // CONTENT yield here rather than per component is what keeps the next
  // `clipToEditorPane` picker from repeating that: the wrapper already knows
  // it is clipped, and the menu component does not have to remember. The rule
  // spans the subtree, not the direct children, and sits in `@layer
  // components` so a menu that states its own cap still wins — see
  // `globals.css` for both.
  if (clipToEditorPane) popup.dataset.suggestionClipped = '';
  popup.style.position = 'fixed';
  // Above every host that can own a suggestion field. At 50 it sat UNDER the
  // comment composer's `z-[60]` card, so `@`-mention results were half-hidden by
  // the box you were typing in. 70 is the same rung `SrcAutocomplete` picked to
  // clear the PropPanel's `z-[60]` popover — a suggestion list has to be above
  // whatever spawned it, and 60 is the ceiling for those hosts.
  popup.style.zIndex = '70';
  // Hide until reveal() — callers stage real content first, then unhide.
  // This eliminates the "flash at wrong position" visible during the initial
  // sync placement (before computePosition's first resolution) and during
  // async loading-state → populated-content transitions (wiki-link).
  popup.style.visibility = 'hidden';
  document.body.appendChild(popup);

  const virtualEl = {
    getBoundingClientRect: () => getCurrentProps()?.clientRect?.() ?? new DOMRect(),
    get contextElement() {
      return getCurrentProps()?.editor.view.dom;
    },
  };

  let revealRequested = false;
  let revealed = false;

  const doPosition = () => {
    if (!popup.isConnected) return;
    // Reset max-height before computePosition so flip() measures the popup's
    // natural content height, not the constrained height from a previous size()
    // pass. Without this, async menus (wiki-link) get stuck below the cursor:
    // the loading state is small → size() constrains max-height to the small
    // available space → items load but flip() still sees the constrained height
    // → never flips above. The fallback 40vh matches the component's CSS default.
    popup.style.removeProperty('--suggestion-menu-max-height');
    const editor = clipToEditorPane ? getCurrentProps()?.editor : undefined;
    computePosition(virtualEl, popup, {
      placement: 'bottom-start',
      middleware: buildMiddleware(popup, editor),
    })
      .then(({ x, y }) => {
        if (popup.isConnected) {
          popup.style.left = `${x}px`;
          popup.style.top = `${y}px`;
          // Reveal on the first computePosition resolution after reveal() was
          // requested. Position is stable now, so showing the popup won't cause
          // a visible reposition.
          if (revealRequested && !revealed) {
            popup.style.removeProperty('visibility');
            revealed = true;
          }
        }
      })
      .catch((err) => {
        if (popup.isConnected) {
          console.warn(`[${label}] computePosition failed`, err);
        }
      });
  };

  // Caller invokes startAutoUpdate() AFTER appending renderer content
  const startAutoUpdate = () => autoUpdate(virtualEl, popup, doPosition);

  // Caller invokes reveal() once content is ready (sync menus: immediately;
  // async menus: after items have loaded). The popup becomes visible after
  // the next computePosition resolution.
  const reveal = () => {
    if (revealed) return;
    revealRequested = true;
    doPosition();
  };

  return { popup, doPosition, startAutoUpdate, reveal };
}

/**
 * Clean up a suggestion popup. Order: stop positioning → remove DOM → caller destroys renderer.
 */
export function destroySuggestionPopup(state: SuggestionPositionState): void {
  state.stopAutoUpdate?.();
  state.stopAutoUpdate = null;
  state.popup?.remove();
  state.popup = null;
}
