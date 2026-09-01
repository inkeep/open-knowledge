import { hasOkPathSegment } from '@/components/file-tree-utils';

export const FEEDBACK_NUDGE_STORAGE_KEY = 'ok-feedback-nudge-v1';

export const FEEDBACK_NUDGE_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export const FEEDBACK_NUDGE_MIN_DOCS = 10;

export interface FeedbackNudgeState {
  readonly firstSeenAt: number | null;
  readonly shownAt: number | null;
  readonly dismissed: boolean;
}

export const DEFAULT_FEEDBACK_NUDGE_STATE: FeedbackNudgeState = {
  firstSeenAt: null,
  shownAt: null,
  dismissed: false,
};

export interface FeedbackNudgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FeedbackNudgeStore {
  getSnapshot(): FeedbackNudgeState;
  subscribe(listener: () => void): () => void;
  recordFirstSeen(now: number): void;
  recordShown(now: number): void;
  dismiss(): void;
  syncFromStorage(): void;
  install(): void;
}

export function countUserDocuments(pages: ReadonlySet<string>): number {
  let count = 0;
  for (const docName of pages) {
    if (!hasOkPathSegment(docName)) count++;
  }
  return count;
}

export function isFeedbackNudgeEligible(
  state: FeedbackNudgeState,
  now: number,
  docCount: number,
): boolean {
  return (
    !state.dismissed &&
    state.shownAt == null &&
    state.firstSeenAt != null &&
    now - state.firstSeenAt >= FEEDBACK_NUDGE_MIN_AGE_MS &&
    docCount >= FEEDBACK_NUDGE_MIN_DOCS
  );
}

function asFlag(value: unknown): boolean {
  return value === true;
}

function asEpochMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function coerceState(parsed: unknown): FeedbackNudgeState {
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_FEEDBACK_NUDGE_STATE;
  const obj = parsed as Record<string, unknown>;
  return {
    firstSeenAt: asEpochMs(obj.firstSeenAt),
    shownAt: asEpochMs(obj.shownAt),
    dismissed: asFlag(obj.dismissed),
  };
}

export function readPersistedState(storage?: FeedbackNudgeStorage): FeedbackNudgeState {
  try {
    const s = storage ?? localStorage;
    const raw = s.getItem(FEEDBACK_NUDGE_STORAGE_KEY);
    if (raw == null) return DEFAULT_FEEDBACK_NUDGE_STATE;
    return coerceState(JSON.parse(raw));
  } catch (err) {
    console.warn('[feedback-nudge-store] readPersistedState failed (corrupt/privacy/SSR)', err);
    return DEFAULT_FEEDBACK_NUDGE_STATE;
  }
}

export function writePersistedState(
  state: FeedbackNudgeState,
  storage?: FeedbackNudgeStorage,
): void {
  try {
    const s = storage ?? localStorage;
    s.setItem(FEEDBACK_NUDGE_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[feedback-nudge-store] writePersistedState failed (quota/privacy/SSR)', err);
  }
}

export function createFeedbackNudgeStore(storage?: FeedbackNudgeStorage): FeedbackNudgeStore {
  let state = readPersistedState(storage);
  const listeners = new Set<() => void>();
  let installed = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function commit(next: FeedbackNudgeState): void {
    state = next;
    writePersistedState(state, storage);
    notify();
  }

  function syncFromStorage(): void {
    state = readPersistedState(storage);
    notify();
  }

  return {
    getSnapshot(): FeedbackNudgeState {
      return state;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    recordFirstSeen(now): void {
      if (state.firstSeenAt != null) return;
      commit({ ...state, firstSeenAt: now });
    },

    recordShown(now): void {
      if (state.shownAt != null) return;
      commit({ ...state, shownAt: now });
    },

    dismiss(): void {
      if (state.dismissed) return;
      commit({ ...state, dismissed: true });
    },

    syncFromStorage,

    install(): void {
      if (installed) return;
      installed = true;
      syncFromStorage();
    },
  };
}

export const feedbackNudgeStore: FeedbackNudgeStore = createFeedbackNudgeStore();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === FEEDBACK_NUDGE_STORAGE_KEY || event.key === null) {
      feedbackNudgeStore.syncFromStorage();
    }
  });
}

export function installFeedbackNudgeStore(): void {
  feedbackNudgeStore.install();
}
