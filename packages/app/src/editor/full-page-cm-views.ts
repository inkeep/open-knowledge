import type { EditorView } from '@codemirror/view';
import type { FullPageCmHost } from './document-scrollports';

export interface FullPageCmEntry {
  view: EditorView;
  host: FullPageCmHost;
}

const cmViewsByDoc = new Map<string, FullPageCmEntry>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function registerFullPageCmView(
  docName: string,
  view: EditorView,
  host: FullPageCmHost,
): void {
  cmViewsByDoc.set(docName, { view, host });
  notifyListeners();
}

export function unregisterFullPageCmView(docName: string, view: EditorView): void {
  if (cmViewsByDoc.get(docName)?.view === view) {
    cmViewsByDoc.delete(docName);
    notifyListeners();
  }
}

export function getMarkdownSourceViewForDoc(docName: string): EditorView | null {
  const entry = cmViewsByDoc.get(docName);
  return entry?.host === 'sourceEditor' ? entry.view : null;
}

export function getFullPageCmEntryForDoc(docName: string): FullPageCmEntry | null {
  return cmViewsByDoc.get(docName) ?? null;
}

export function subscribeFullPageCmViewRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
