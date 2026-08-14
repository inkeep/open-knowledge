/**
 * windowId-keyed registry of popped-out note windows (`--ok-mode=note`).
 *
 * Note windows are deliberately NOT tracked in the window manager's per-project
 * `windowsByPath` map (one-per-project, focus-existing) so that N pop-outs can
 * coexist for a single project — the case in-window split panes cannot serve.
 * Because they are absent from `windowsByPath`, `getContextForBrowserWindow`
 * returns nothing for them, so main-side project resolution (menus, shell and
 * clipboard handlers) reads their project from here instead.
 *
 * Two properties this registry owns beyond the terminal-window precedent:
 *
 *   - **Identity is content-keyed, not window-keyed.** Dedup is on
 *     `(projectRoot, currentDocName)` so re-invoking "Open in New Window" on an
 *     already-popped document focuses the window that has it. `currentDocName`
 *     is mutable because a note window navigates in place through wiki links, so
 *     a window can drift from the document it was born with.
 *   - **Collisions are permitted and resolved most-recently-used.** In-place
 *     navigation can legitimately land two windows on one identity; that is
 *     allowed, and a re-invoke focuses whichever of them was touched last rather
 *     than erroring or spawning a third.
 */

/** Where an open request came from. Bounded set — it is a telemetry attribute. */
export type NoteWindowEntryPoint = 'tab-menu' | 'palette' | 'window-menu';

export interface NoteWindowContext {
  /** Inherited project root. Note windows are never project-less: a popped-out
   *  document only exists inside a project, unlike a terminal window. */
  readonly projectRoot: string;
  /** Inherited collab server URL (attach-mode). */
  readonly collabUrl: string;
  /** Inherited API origin (attach-mode). */
  readonly apiOrigin: string;
  /** The document the window is showing right now, not the one it opened with. */
  readonly currentDocName: string;
}

/**
 * The stored shape. It restates the context fields rather than extending
 * `NoteWindowContext` because the public type is fully readonly (correct for
 * consumers) while the two fields the registry itself mutates — the document a
 * window navigated to, and its focus recency — must not be.
 */
interface NoteWindowRecord {
  readonly projectRoot: string;
  readonly collabUrl: string;
  readonly apiOrigin: string;
  currentDocName: string;
  /** Monotonic touch counter; the tiebreak when two windows share an identity. */
  touchSeq: number;
}

const noteWindows = new Map<number, NoteWindowRecord>();
let touchCounter = 0;

export function registerNoteWindow(windowId: number, context: NoteWindowContext): void {
  touchCounter += 1;
  noteWindows.set(windowId, { ...context, touchSeq: touchCounter });
}

export function getNoteWindowContext(windowId: number): NoteWindowContext | undefined {
  const record = noteWindows.get(windowId);
  if (!record) return undefined;
  const { touchSeq: _touchSeq, ...context } = record;
  return context;
}

export function unregisterNoteWindow(windowId: number): void {
  noteWindows.delete(windowId);
}

/**
 * Re-point a window at the document it navigated to, so the dedup identity and
 * anything keyed off it (title, menu targeting) follow the window rather than
 * its birth document. No-ops for an unregistered window so a late navigation
 * push from a closing window cannot resurrect a dropped entry.
 */
export function setNoteWindowDoc(windowId: number, docName: string): boolean {
  const record = noteWindows.get(windowId);
  if (!record) return false;
  record.currentDocName = docName;
  return true;
}

/** Mark a window as most recently used. Called on focus. */
export function touchNoteWindow(windowId: number): void {
  const record = noteWindows.get(windowId);
  if (!record) return;
  touchCounter += 1;
  record.touchSeq = touchCounter;
}

/**
 * The dedup lookup: the window already showing this document in this project,
 * or undefined. When several windows share the identity (reachable only through
 * in-place navigation) the most recently touched one wins.
 */
export function findNoteWindowForDoc(projectRoot: string, docName: string): number | undefined {
  let bestId: number | undefined;
  let bestSeq = -1;
  for (const [windowId, record] of noteWindows) {
    if (record.projectRoot !== projectRoot) continue;
    if (record.currentDocName !== docName) continue;
    if (record.touchSeq > bestSeq) {
      bestSeq = record.touchSeq;
      bestId = windowId;
    }
  }
  return bestId;
}

/** Every note window belonging to a project, for the owner-close cascade and
 *  for the restore snapshot. Ordered oldest-touched first for stable output. */
export function listNoteWindowsForProject(projectRoot: string): number[] {
  return [...noteWindows.entries()]
    .filter(([, record]) => record.projectRoot === projectRoot)
    .sort((a, b) => a[1].touchSeq - b[1].touchSeq)
    .map(([windowId]) => windowId);
}

/** Every registered note window with its context. The restore snapshot source. */
export function listNoteWindows(): Array<{ windowId: number; context: NoteWindowContext }> {
  return [...noteWindows.entries()]
    .sort((a, b) => a[1].touchSeq - b[1].touchSeq)
    .map(([windowId, record]) => {
      const { touchSeq: _touchSeq, ...context } = record;
      return { windowId, context };
    });
}

/** Test-only: drop every entry so the module-global Map cannot leak across cases. */
export function __resetNoteWindowRegistryForTests(): void {
  noteWindows.clear();
  touchCounter = 0;
}
