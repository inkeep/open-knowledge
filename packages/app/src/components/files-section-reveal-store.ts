/**
 * "Take me to the file browser" — a reveal request from surfaces that open a
 * document but live outside the Files section (the symlinked-skill banner's
 * Open file, which opens the editable source as a doc tab). Opening the tab
 * alone is not enough: the Files collapsible can be closed and the Skills dock
 * holding the sidebar, so the file the user asked to see never appears. The
 * request asks `FileSidebar` to expand Files; the tree's reveal-active-row
 * effect then scrolls the newly active doc into view.
 *
 * Event-ish store (`request` / `subscribeTo` naming, matching the other
 * request stores): a reveal is requested and consumed, not read back.
 */
const listeners = new Set<() => void>();

export function requestFilesSectionReveal(): void {
  for (const listener of listeners) listener();
}

export function subscribeToFilesSectionReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
