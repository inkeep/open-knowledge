import { type RefObject, useEffect, useSyncExternalStore } from 'react';
import {
  getSelectionContext,
  publishSelectionContext,
  type SelectionSnapshot,
  selectionSnapshotFromFrontmatter,
  subscribeSelectionContext,
} from '@/editor/selection-context';
import type { EditorSurface } from '@/editor/selection-stats';

/**
 * The active doc's current selection snapshot for the visible surface, or `null`
 * when there is no live selection. Sibling of `useSelectionStats`; the bottom
 * composer subscribes to capture a removable selection pill. The stored snapshot
 * is a stable reference (or `null`), so it does not churn `useSyncExternalStore`
 * between publishes.
 */
export function useSelectionContext(
  activeDocName: string | null,
  surface: EditorSurface,
): SelectionSnapshot | null {
  return useSyncExternalStore(subscribeSelectionContext, () =>
    getSelectionContext(activeDocName, surface),
  );
}

/**
 * Read the highlighted text inside `container`, whether the highlight lives in
 * a DOM Range (a static value display — a link chip, the key name) or inside a
 * form field (the property widgets render `<textarea>` / `<input>`, whose
 * highlighted substring is the element's own `selectionStart..selectionEnd`, NOT
 * part of `window.getSelection()`). Returns the empty string when nothing inside
 * the container is selected.
 */
function readFrontmatterSelection(container: HTMLElement): string {
  // Duck-typed (not `instanceof`) so it works regardless of whether the host
  // exposes `HTMLTextAreaElement` / `HTMLInputElement` as globals — a text-input
  // field carries its own `selectionStart`/`selectionEnd`/`value`.
  const active = document.activeElement as
    | (Element & { selectionStart?: number | null; selectionEnd?: number | null; value?: string })
    | null;
  if (active && container.contains(active) && typeof active.value === 'string') {
    const { selectionStart, selectionEnd, value } = active;
    if (
      selectionStart != null &&
      selectionEnd != null &&
      selectionEnd > selectionStart &&
      // `<select>` also has a `value` but no text-range selection — its
      // selectionStart/End are absent, so the null-guard above already excludes it.
      typeof value === 'string'
    ) {
      return value.slice(selectionStart, selectionEnd);
    }
  }
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  // Only honor a Range whose common ancestor is inside the property panel — a
  // body-editor selection must not leak in as a frontmatter snapshot.
  const node =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  if (!node || !container.contains(node)) return '';
  return sel.toString();
}

/**
 * Publish a frontmatter (property-panel) text selection into the same
 * selection-context store the body surfaces use, keyed `(docName, 'frontmatter')`.
 * The property panel is plain React widgets — not an editor — so this hook wires
 * the DOM-level `selectionchange` signal that the body editors get from
 * TipTap/CodeMirror listeners: when the user highlights property text the
 * composer pins it as a context pill, identical to a body selection (no per-row
 * "use as context" button). A collapsed / outside highlight clears the entry.
 */
export function usePublishFrontmatterSelection(
  containerRef: RefObject<HTMLElement | null>,
  docName: string,
): void {
  useEffect(() => {
    if (typeof document === 'undefined' || docName === '') return;
    const onSelectionChange = () => {
      const container = containerRef.current;
      if (!container) return;
      const text = readFrontmatterSelection(container);
      publishSelectionContext(
        docName,
        'frontmatter',
        text === '' ? null : selectionSnapshotFromFrontmatter(text, docName),
      );
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      // Clear this doc's frontmatter entry when the panel unmounts so a stale
      // selection doesn't linger in the composer after navigating away.
      publishSelectionContext(docName, 'frontmatter', null);
    };
  }, [containerRef, docName]);
}
