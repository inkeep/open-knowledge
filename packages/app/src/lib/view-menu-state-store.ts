import { useSyncExternalStore } from 'react';
import type { OkEditorViewMenuStateSnapshot } from './desktop-bridge-types';

/**
 * Renderer-side mirror of the View-menu state that components already push to
 * main via `bridge.editor.notifyViewMenuStateChanged(...)`. That push is
 * write-only (main consumes it to build "Show/Hide …" menu labels); nothing in
 * the renderer could read it back. The command palette needs the same values to
 * render state-reflecting toggle labels and to gate `kill-terminal` on a live
 * terminal, so each producer writes the SAME partial here alongside its bridge
 * push. This store is that single readable snapshot.
 *
 * All fields are optional: producers push partials, and a field stays undefined
 * until its producer mounts. Consumers treat undefined as "unknown / default".
 */
export type ViewMenuState = Partial<OkEditorViewMenuStateSnapshot>;

let state: ViewMenuState = {};
const listeners = new Set<() => void>();

/** Current snapshot. Referentially stable between `setViewMenuState` calls. */
function getViewMenuState(): ViewMenuState {
  return state;
}

/**
 * Merge a partial into the snapshot and notify subscribers. Producers call this
 * with the same object they pass to `notifyViewMenuStateChanged`, keeping the
 * renderer mirror and the main-side menu in lockstep.
 */
export function setViewMenuState(partial: ViewMenuState): void {
  state = { ...state, ...partial };
  for (const cb of listeners) {
    cb();
  }
}

function subscribeViewMenuState(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test-only reset so each test starts from an empty module singleton. */
export function __resetViewMenuStateForTests(): void {
  state = {};
  listeners.clear();
}

/**
 * React binding for the palette. `getViewMenuState` returns a stable reference
 * between updates (a new object is only created on `setViewMenuState`), so
 * `useSyncExternalStore` re-renders exactly when a producer changes state.
 */
export function useViewMenuState(): ViewMenuState {
  return useSyncExternalStore(subscribeViewMenuState, getViewMenuState, getViewMenuState);
}
