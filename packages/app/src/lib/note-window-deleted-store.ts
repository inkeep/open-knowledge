/**
 * Terminal state for a popped-out note window whose document was deleted.
 *
 * A workspace window navigates home when its active document disappears. A note
 * window cannot: it shows exactly one document and deliberately has no home
 * surface to land on, so navigating there would strand the user in an empty
 * shell with no explanation. It shows an explicit deleted state instead and
 * lets the user close the window.
 *
 * Module-level rather than context state because the trigger arrives from the
 * provider pool's auth-rejection path, outside React's render tree, and the one
 * consumer is the window's own editor surface.
 */

const listeners = new Set<() => void>();
let deletedDocName: string | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Record that this window's document is gone. Returns true so the removal
 * reconciler can treat it as "handled" and skip its navigate-home.
 */
export function markNoteWindowDocDeleted(docName: string): boolean {
  if (deletedDocName === docName) return true;
  deletedDocName = docName;
  emit();
  return true;
}

/** The deleted document's name, or null while the window is healthy. */
export function getNoteWindowDeletedDoc(): string | null {
  return deletedDocName;
}

export function subscribeNoteWindowDeleted(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: return the window to its healthy state. */
export function __resetNoteWindowDeletedForTests(): void {
  deletedDocName = null;
  emit();
}
