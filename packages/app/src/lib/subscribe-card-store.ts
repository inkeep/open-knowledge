export const SUBSCRIBE_CARD_STORAGE_KEY = 'ok-subscribe-card-v1';

export const MAX_SUBSCRIBE_CARD_SHOWS = 3;

export interface SubscribeCardState {
  readonly subscribed: boolean;
  readonly dismissed: boolean;
  readonly shownVersions: readonly string[];
}

export const DEFAULT_SUBSCRIBE_CARD_STATE: SubscribeCardState = {
  subscribed: false,
  dismissed: false,
  shownVersions: [],
};

export interface SubscribeCardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SubscribeCardStore {
  getSnapshot(): SubscribeCardState;
  subscribe(listener: () => void): () => void;
  markSubscribed(): void;
  dismiss(): void;
  recordShown(version: string): void;
  install(): void;
}

export function isSubscribeCombinedEligible(state: SubscribeCardState, version: string): boolean {
  return (
    !state.subscribed &&
    !state.dismissed &&
    state.shownVersions.length < MAX_SUBSCRIBE_CARD_SHOWS &&
    !state.shownVersions.includes(version)
  );
}

function asFlag(value: unknown): boolean {
  return value === true;
}

function asVersionList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function coerceState(parsed: unknown): SubscribeCardState {
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SUBSCRIBE_CARD_STATE;
  const obj = parsed as Record<string, unknown>;
  return {
    subscribed: asFlag(obj.subscribed),
    dismissed: asFlag(obj.dismissed),
    shownVersions: asVersionList(obj.shownVersions),
  };
}

export function readPersistedState(storage?: SubscribeCardStorage): SubscribeCardState {
  try {
    const s = storage ?? localStorage;
    const raw = s.getItem(SUBSCRIBE_CARD_STORAGE_KEY);
    if (raw == null) return DEFAULT_SUBSCRIBE_CARD_STATE;
    return coerceState(JSON.parse(raw));
  } catch (err) {
    console.warn('[subscribe-card-store] readPersistedState failed (corrupt/privacy/SSR)', err);
    return DEFAULT_SUBSCRIBE_CARD_STATE;
  }
}

export function writePersistedState(
  state: SubscribeCardState,
  storage?: SubscribeCardStorage,
): void {
  try {
    const s = storage ?? localStorage;
    s.setItem(SUBSCRIBE_CARD_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[subscribe-card-store] writePersistedState failed (quota/privacy/SSR)', err);
  }
}

export function createSubscribeCardStore(storage?: SubscribeCardStorage): SubscribeCardStore {
  let state = readPersistedState(storage);
  const listeners = new Set<() => void>();
  let installed = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function commit(next: SubscribeCardState): void {
    state = next;
    writePersistedState(state, storage);
    notify();
  }

  return {
    getSnapshot(): SubscribeCardState {
      return state;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    markSubscribed(): void {
      if (state.subscribed) return;
      commit({ ...state, subscribed: true });
    },

    dismiss(): void {
      if (state.dismissed) return;
      commit({ ...state, dismissed: true });
    },

    recordShown(version): void {
      if (state.shownVersions.includes(version)) return;
      commit({ ...state, shownVersions: [...state.shownVersions, version] });
    },

    install(): void {
      if (installed) return;
      installed = true;
      state = readPersistedState(storage);
      notify();
    },
  };
}

export const subscribeCardStore: SubscribeCardStore = createSubscribeCardStore();

export function installSubscribeCardStore(): void {
  subscribeCardStore.install();
}
