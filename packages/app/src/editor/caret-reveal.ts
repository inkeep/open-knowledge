import { mark } from '@/lib/perf';
import { getVisibleEditorForDoc } from './active-editor';
import { DOCUMENT_SCROLL_HOST_SELECTOR, FULL_PAGE_CM_SCROLLPORTS } from './document-scrollports';
import { getFullPageCmEntryForDoc } from './full-page-cm-views';
import type { EditorSurface } from './selection-stats';
import { getEditorView } from './utils/get-editor-view';

export const CARET_REVEAL_GAP_PX = 28;

export interface CaretRevealTarget {
  caretBottom: number;
  scrollport: HTMLElement;
}

interface CaretCoordsSource {
  coordsAtPos(pos: number): { bottom: number } | null;
}

function safeCaretCoords(
  docName: string,
  surface: EditorSurface,
  view: CaretCoordsSource,
  pos: number,
): { bottom: number } | null {
  try {
    return view.coordsAtPos(pos);
  } catch (err) {
    mark('ok/caret-reveal/coords-failed', {
      docName,
      surface,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function scrollportFor(from: Element, selector: string): HTMLElement | null {
  const scrollport = from.closest(selector);
  return scrollport instanceof HTMLElement ? scrollport : null;
}

function targetFrom(
  docName: string,
  surface: EditorSurface,
  view: CaretCoordsSource,
  pos: number,
  from: Element,
  selector: string,
): CaretRevealTarget | null {
  const caret = safeCaretCoords(docName, surface, view, pos);
  if (caret === null) return null;
  const scrollport = scrollportFor(from, selector);
  return scrollport === null ? null : { caretBottom: caret.bottom, scrollport };
}

export function __caretRevealTargetFor(
  docName: string,
  surface: EditorSurface,
): CaretRevealTarget | null {
  switch (surface) {
    case 'wysiwyg': {
      const editor = getVisibleEditorForDoc(docName);
      if (!editor) return null;
      const view = getEditorView(editor);
      if (!view) return null;
      return targetFrom(
        docName,
        surface,
        view,
        view.state.selection.head,
        view.dom,
        DOCUMENT_SCROLL_HOST_SELECTOR,
      );
    }
    case 'source': {
      const entry = getFullPageCmEntryForDoc(docName);
      if (!entry) return null;
      const { view, host } = entry;
      return targetFrom(
        docName,
        surface,
        view,
        view.state.selection.main.head,
        view.scrollDOM,
        FULL_PAGE_CM_SCROLLPORTS[host],
      );
    }
    case 'frontmatter':
      return null;
  }
}

export function revealCaretAboveComposerCard({
  docName,
  surface,
  card,
}: {
  docName: string;
  surface: EditorSurface;
  card: HTMLElement;
}): void {
  const cardBox = card.getBoundingClientRect();
  if (cardBox.height === 0) return;
  const target = __caretRevealTargetFor(docName, surface);
  if (target === null) return;
  const port = target.scrollport.getBoundingClientRect();
  if (port.height === 0) return;
  const occlusionTop = Math.min(cardBox.top, port.bottom);
  const overlap = target.caretBottom - (occlusionTop - CARET_REVEAL_GAP_PX);
  if (overlap <= 0) return;
  target.scrollport.scrollTop += overlap;
}
