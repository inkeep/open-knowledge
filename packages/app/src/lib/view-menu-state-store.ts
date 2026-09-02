import { useSyncExternalStore } from 'react';
import type { OkEditorViewMenuStateSnapshot } from './desktop-bridge-types';

export type ViewMenuState = Partial<OkEditorViewMenuStateSnapshot>;

let state: ViewMenuState = {};
const listeners = new Set<() => void>();

function getViewMenuState(): ViewMenuState {
  return state;
}

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

export function __resetViewMenuStateForTests(): void {
  state = {};
  listeners.clear();
}

export function useViewMenuState(): ViewMenuState {
  return useSyncExternalStore(subscribeViewMenuState, getViewMenuState, getViewMenuState);
}
