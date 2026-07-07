import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import type { SuggestionProps } from '@tiptap/suggestion';

export interface SuggestionPositionState {
  popup: HTMLDivElement | null;
  stopAutoUpdate: (() => void) | null;
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
 */
export function createSuggestionPopup(
  getCurrentProps: () => SuggestionProps<unknown> | null,
  label: string,
): {
  popup: HTMLDivElement;
  doPosition: () => void;
  startAutoUpdate: () => () => void;
  reveal: () => void;
} {
  const popup = document.createElement('div');
  popup.style.position = 'fixed';
  popup.style.zIndex = '50';
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
    computePosition(virtualEl, popup, {
      placement: 'bottom-start',
      middleware: [
        offset(4),
        flip(),
        // Keep the popup inside the viewport when its width pushes past the
        // right edge — required since the slash-menu preview panel widened the
        // popup to ~490px, where right-half cursor positions or narrow viewports
        // would otherwise clip the preview.
        shift({ padding: 8 }),
        size({
          apply({ availableHeight }) {
            if (popup.isConnected) {
              popup.style.setProperty(
                '--suggestion-menu-max-height',
                `${Math.min(availableHeight, window.innerHeight * 0.4)}px`,
              );
            }
          },
        }),
      ],
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
