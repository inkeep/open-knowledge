import { useSyncExternalStore } from 'react';

export const ONBOARDING_CARD_STORAGE_KEY = 'ok-onboarding-card-v1';

type OnboardingStep = 'file' | 'askedAi';

export interface OnboardingCardState {
  readonly initialized: boolean;
  readonly steps: {
    readonly file: boolean;
    readonly askedAi: boolean;
  };
  readonly fileBaseline: number;
  readonly dismissed: boolean;
  readonly completed: boolean;
}

export const DEFAULT_ONBOARDING_CARD_STATE: OnboardingCardState = {
  initialized: false,
  steps: { file: false, askedAi: false },
  fileBaseline: 0,
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
  activate(fileBaseline?: number): void;
  markStepComplete(step: OnboardingStep): void;
  dismiss(): void;
  markCompleted(): void;
  install(): void;
}

function asFlag(value: unknown): boolean {
  return value === true;
}

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
    fileBaseline:
      typeof obj.fileBaseline === 'number' &&
      Number.isFinite(obj.fileBaseline) &&
      obj.fileBaseline >= 0
        ? obj.fileBaseline
        : 0,
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

    activate(fileBaseline = 0): void {
      if (state.initialized) return;
      commit({ ...state, initialized: true, fileBaseline });
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
      state = readPersistedState(storage);
      notify();
    },
  };
}

export const onboardingCardStore: OnboardingCardStore = createOnboardingCardStore();

export function useOnboardingCardState(
  store: OnboardingCardStore = onboardingCardStore,
): OnboardingCardState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function installOnboardingCardStore(): void {
  onboardingCardStore.install();
}
