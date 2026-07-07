/**
 * Subscribe card store — device-local persistence for the "Stay in the loop"
 * prompt that rides along with the post-update release-notes ("what's new")
 * card. It is never standalone: the combined card only appears when a what's-new
 * notice fires (i.e. after an app update), so "returning user / not first run"
 * is implied and needs no probe.
 *
 * Three persisted facts gate whether the subscribe prompt is added to a
 * what's-new card:
 *   - `subscribed`     — the user completed a subscribe (here OR via the
 *     Resources popover; both call `markSubscribed`). Suppresses forever.
 *   - `dismissed`      — the user closed the combined card. Suppresses forever.
 *   - `shownVersions`  — the update versions the combined card has already been
 *     shown for. Caps the prompt at `MAX_SUBSCRIBE_CARD_SHOWS` distinct
 *     versions, and — keyed by version — keeps a reopen on the SAME version from
 *     re-showing the combined card (`shownVersions.length` is the show count).
 *
 * Mirrors `onboarding-card-store`: a module-level singleton bound to React via
 * `useSyncExternalStore`, mirrored to localStorage, re-read on construction.
 */

export const SUBSCRIBE_CARD_STORAGE_KEY = 'ok-subscribe-card-v1';

/** Show the combined card for at most this many distinct update versions, then never again. */
export const MAX_SUBSCRIBE_CARD_SHOWS = 3;

export interface SubscribeCardState {
  /** User subscribed (from the combined card or the Resources popover). */
  readonly subscribed: boolean;
  /** User closed the combined card. */
  readonly dismissed: boolean;
  /** Update versions the combined card has already been shown for. */
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
  /** Persist that the user subscribed (idempotent). Suppresses the prompt forever. */
  markSubscribed(): void;
  /** Persist that the user dismissed the combined card (idempotent). */
  dismiss(): void;
  /** Record that the combined card was shown for `version` (idempotent per version). */
  recordShown(version: string): void;
  /** Re-sync from storage at app boot. Idempotent. */
  install(): void;
}

/**
 * True when the subscribe prompt should be added to the what's-new card for
 * `version`: the user hasn't subscribed or dismissed, the per-version budget
 * isn't spent, and this specific version hasn't already shown the combined card
 * (so a reopen on the same version doesn't re-nag).
 */
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

/**
 * Coerce arbitrary parsed JSON into a valid state. Every field defaults safely
 * so partial, corrupt, or forward/backward-incompatible payloads degrade rather
 * than throw.
 */
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
    // Absent / throwing localStorage (SSR, Safari private mode, sandboxed
    // iframe) or corrupt JSON — fall back to defaults so module init never
    // crashes.
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
    // Quota exceeded / privacy mode / SSR — in-memory state holds for the session.
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
      // Re-read at boot in case the singleton was constructed before storage
      // was reachable (module graph import order).
      state = readPersistedState(storage);
      notify();
    },
  };
}

export const subscribeCardStore: SubscribeCardStore = createSubscribeCardStore();

export function installSubscribeCardStore(): void {
  subscribeCardStore.install();
}
