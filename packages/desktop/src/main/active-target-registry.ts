/**
 * Per-window store for the active-editor target the renderer pushes over
 * `ok:editor:active-target-changed`.
 *
 * Keyed per window rather than a single module-scope snapshot because two
 * windows on one project both push (popped-out note windows make this routine),
 * and a last-write-wins snapshot would let whichever pushed last own the File
 * menu's Rename / Duplicate / Move to Trash scope regardless of which window the
 * user is looking at. Reading the FOCUSED window's target makes the menu track
 * the window the user is in, and gives a note window a place to read its own
 * current document from for its title.
 *
 * The application menu is a singleton (`Menu.setApplicationMenu` replaces the
 * global menu), so it reflects exactly one window — which is why reading the
 * focused window is the right resolution.
 *
 * Mirrors `EditorViewMenuStateRegistry`, which solves the same problem for
 * view-menu state.
 */

import type { EditorActiveTargetSnapshot } from '../shared/ipc-channels.ts';

/** What main assumes before any renderer push lands: no target, no scope. */
export function createEmptyActiveTarget(): EditorActiveTargetSnapshot {
  return { kind: null };
}

export class EditorActiveTargetRegistry {
  readonly #targets = new Map<number, EditorActiveTargetSnapshot>();
  /**
   * Fallback for menu reads with no focused window — a menu can be rebuilt
   * while the app is briefly unfocused (a dialog, a Space switch), and falling
   * back to "no target" there would flicker every scoped item to disabled.
   */
  #selectedWindowId: number | null = null;

  update(windowId: number, target: EditorActiveTargetSnapshot): void {
    this.#targets.set(windowId, target);
    this.#selectedWindowId = windowId;
  }

  get(windowId: number): EditorActiveTargetSnapshot {
    return this.#targets.get(windowId) ?? createEmptyActiveTarget();
  }

  /** The focused window's target, else the most recent pusher's. */
  current(focusedWindowId: number | null = null): EditorActiveTargetSnapshot {
    const windowId = focusedWindowId ?? this.#selectedWindowId;
    return windowId === null ? createEmptyActiveTarget() : this.get(windowId);
  }

  delete(windowId: number): void {
    this.#targets.delete(windowId);
    if (this.#selectedWindowId === windowId) this.#selectedWindowId = null;
  }
}

/**
 * The document a target snapshot points at, or null for any non-doc target.
 * A note window's title and its registry identity both track this.
 */
export function docNameFromActiveTarget(target: EditorActiveTargetSnapshot): string | null {
  return target.kind === 'doc' && target.identifier.length > 0 ? target.identifier : null;
}
