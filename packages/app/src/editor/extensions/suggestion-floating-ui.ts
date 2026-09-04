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

const SUGGESTION_ANCHOR_GAP_PX = 4;

const suggestionSelectableCounts = new WeakMap<object, number>();

export function setSuggestionSelectableCount(view: object, count: number): void {
  suggestionSelectableCounts.set(view, count);
}

export function clearSuggestionSelectableCount(view: object): void {
  suggestionSelectableCounts.delete(view);
}

export function suggestionHasSelectableItem(view: object): boolean {
  return (suggestionSelectableCounts.get(view) ?? 0) > 0;
}

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
    return [offset(SUGGESTION_ANCHOR_GAP_PX), flip(), shift({ padding: 8 }), size(applySize)];
  }
  const clipOptions = deriveEditorClipOptions(editor);
  const capWidth = deriveEditorSizeOptions(editor);
  return [
    offset(SUGGESTION_ANCHOR_GAP_PX),
    flip(clipOptions),
    size(() => {
      const { apply: applyWidthCap } = capWidth();
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

function applyColumnCount(popup: HTMLDivElement, regionWidth: number | null): void {
  if (!popup.isConnected || regionWidth === null) return;
  popup.toggleAttribute('data-suggestion-narrow', regionWidth < SUGGESTION_TWO_COLUMN_MIN_PX);
}

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
  popup.dataset.suggestionPopup = label;
  if (clipToEditorPane) popup.dataset.suggestionClipped = '';
  popup.style.position = 'fixed';
  popup.style.zIndex = '70';
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

  const startAutoUpdate = () => autoUpdate(virtualEl, popup, doPosition);

  const reveal = () => {
    if (revealed) return;
    revealRequested = true;
    doPosition();
  };

  return { popup, doPosition, startAutoUpdate, reveal };
}

export function destroySuggestionPopup(state: SuggestionPositionState): void {
  state.stopAutoUpdate?.();
  state.stopAutoUpdate = null;
  state.popup?.remove();
  state.popup = null;
}
