/**
 * Onboarding card store — device-local persistence for the first-run
 * onboarding checklist (per-step completion, dismissal, completion).
 *
 * Module-level singleton bound to React via `useSyncExternalStore`. The card
 * mounts deep in the editor tree and remounts across layout changes, so the
 * canonical state has to outlive any single component instance — React state
 * inside the card would reset on every remount and lose progress. State is
 * mirrored to localStorage and re-read on construction so progress survives a
 * reload: the visibility predicate keys off `dismissed` / `completed` to keep
 * a dismissed or finished card from ever returning on this device.
 *
 * `update-notices-store` is the module-store precedent but is in-memory only;
 * the localStorage round-trip here is what makes the state durable.
 *
 * `createOnboardingCardStore(storage)` exists so tests run against an isolated
 * instance over an injected storage fake; the app uses the `onboardingCardStore`
 * singleton over real localStorage. Every storage access is wrapped so a
 * throwing or absent `localStorage` (Safari private mode, quota, SSR) degrades
 * to in-memory state rather than crashing module init.
 */

import { useSyncExternalStore } from 'react';

export const ONBOARDING_CARD_STORAGE_KEY = 'ok-onboarding-card-v1';

/** The two reactively-tracked steps. Step 1 (project) is always pre-checked in the UI, so it has no persisted flag. */
type OnboardingStep = 'file' | 'askedAi';

export interface OnboardingCardState {
  readonly initialized: boolean;
  readonly steps: {
    readonly file: boolean;
    readonly askedAi: boolean;
  };
  readonly dismissed: boolean;
  readonly completed: boolean;
}

export const DEFAULT_ONBOARDING_CARD_STATE: OnboardingCardState = {
  initialized: false,
  steps: { file: false, askedAi: false },
  dismissed: false,
  completed: false,
};

export interface OnboardingCardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface OnboardingCardStore {
  getSnapshot(): OnboardingCardState;
  subscribe(listener: () => void): () => void;
  /** Latch the card on for a fresh project. Idempotent — never regresses an already-initialized store. */
  activate(): void;
  markStepComplete(step: OnboardingStep): void;
  dismiss(): void;
  markCompleted(): void;
  /** Re-sync from storage at app boot, after which reactive completion wiring attaches. Idempotent. */
  install(): void;
}

function asFlag(value: unknown): boolean {
  return value === true;
}

/**
 * Coerce arbitrary parsed JSON into a valid state. Every field defaults to
 * false unless explicitly stored `true`, so partial, corrupt, or
 * forward/backward-incompatible payloads degrade safely instead of throwing.
 */
function coerceState(parsed: unknown): OnboardingCardState {
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_ONBOARDING_CARD_STATE;
  const obj = parsed as Record<string, unknown>;
  const steps =
    typeof obj.steps === 'object' && obj.steps !== null
      ? (obj.steps as Record<string, unknown>)
      : {};
  return {
    initialized: asFlag(obj.initialized),
    steps: { file: asFlag(steps.file), askedAi: asFlag(steps.askedAi) },
    dismissed: asFlag(obj.dismissed),
    completed: asFlag(obj.completed),
  };
}

export function readPersistedState(storage?: OnboardingCardStorage): OnboardingCardState {
  try {
    const s = storage ?? localStorage;
    const raw = s.getItem(ONBOARDING_CARD_STORAGE_KEY);
    if (raw == null) return DEFAULT_ONBOARDING_CARD_STATE;
    return coerceState(JSON.parse(raw));
  } catch (err) {
    // Absent / throwing localStorage (SSR, Safari private mode, sandboxed
    // iframe) or corrupt JSON — fall back to defaults so module init never
    // crashes. Log (matching writePersistedState) so a silent privacy/parse
    // degradation is distinguishable from a correct not-yet-activated state.
    console.warn('[onboarding-card-store] readPersistedState failed (corrupt/privacy/SSR)', err);
    return DEFAULT_ONBOARDING_CARD_STATE;
  }
}

export function writePersistedState(
  state: OnboardingCardState,
  storage?: OnboardingCardStorage,
): void {
  try {
    const s = storage ?? localStorage;
    s.setItem(ONBOARDING_CARD_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // Quota exceeded / privacy mode / SSR — in-memory state holds for the session.
    console.warn('[onboarding-card-store] writePersistedState failed (quota/privacy/SSR)', err);
  }
}

export function createOnboardingCardStore(storage?: OnboardingCardStorage): OnboardingCardStore {
  let state = readPersistedState(storage);
  const listeners = new Set<() => void>();
  let installed = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function commit(next: OnboardingCardState): void {
    state = next;
    writePersistedState(state, storage);
    notify();
  }

  return {
    getSnapshot(): OnboardingCardState {
      return state;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    activate(): void {
      if (state.initialized) return;
      commit({ ...state, initialized: true });
    },

    markStepComplete(step): void {
      if (state.steps[step]) return;
      commit({ ...state, steps: { ...state.steps, [step]: true } });
    },

    dismiss(): void {
      if (state.dismissed) return;
      commit({ ...state, dismissed: true });
    },

    markCompleted(): void {
      if (state.completed) return;
      commit({ ...state, completed: true });
    },

    install(): void {
      if (installed) return;
      installed = true;
      // Re-read at boot in case the singleton was constructed before storage
      // was reachable (module graph import order). Read-only — mutations are
      // what write through, so this can only converge on the persisted value.
      state = readPersistedState(storage);
      notify();
    },
  };
}

export const onboardingCardStore: OnboardingCardStore = createOnboardingCardStore();

/**
 * React binding. `subscribe` / `getSnapshot` are stable store methods, so
 * `useSyncExternalStore` re-renders only when state actually changes. The
 * `store` parameter is a test seam (pass a `createOnboardingCardStore(...)`
 * instance); production callers use the singleton default.
 */
export function useOnboardingCardState(
  store: OnboardingCardStore = onboardingCardStore,
): OnboardingCardState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function installOnboardingCardStore(): void {
  onboardingCardStore.install();
}
