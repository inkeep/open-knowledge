/**
 * Feedback nudge store — device-local persistence for the one-time proactive
 * feedback card. The card asks an engaged, past-the-honeymoon user how
 * OpenKnowledge is going and opens the existing feedback form.
 *
 * Three persisted facts gate it:
 *   - `firstSeenAt` — epoch ms of the first boot that ever observed this store.
 *     Starts the two-week clock. Approximate by construction: there is no
 *     install timestamp anywhere in the product, so a user who installed months
 *     ago starts their clock on the first boot after this ships.
 *   - `shownAt`     — when the card was first shown. Non-null suppresses
 *     forever: the card gets exactly one session on screen, then never returns,
 *     whether the user engaged with it or ignored it.
 *   - `dismissed`   — the user answered (closed the card or closed the feedback
 *     form). Suppresses forever.
 *
 * Mirrors `subscribe-card-store`: a module-level singleton bound to React via
 * `useSyncExternalStore`, mirrored to localStorage, re-read on construction.
 * Cross-window sync follows `enabled-agents` — a `storage` event on the
 * singleton re-reads persisted state so a dismiss in one window clears the card
 * in every other open window without a reload.
 */

import { hasOkPathSegment } from '@/components/file-tree-utils';

export const FEEDBACK_NUDGE_STORAGE_KEY = 'ok-feedback-nudge-v1';

/** How long after first boot the nudge becomes eligible. */
export const FEEDBACK_NUDGE_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** How many user documents the workspace must hold for the nudge to be eligible. */
export const FEEDBACK_NUDGE_MIN_DOCS = 10;

export interface FeedbackNudgeState {
  /** Epoch ms of the first boot that observed this store; null until set. */
  readonly firstSeenAt: number | null;
  /** Epoch ms the card was first shown; null until it fires. */
  readonly shownAt: number | null;
  /** The user answered the nudge — card closed, or the feedback form closed. */
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
  /** Start the two-week clock. No-op once `firstSeenAt` is set. */
  recordFirstSeen(now: number): void;
  /** Latch the one-shot show. No-op once `shownAt` is set. */
  recordShown(now: number): void;
  /** Persist that the user answered the nudge (idempotent). */
  dismiss(): void;
  /**
   * Re-read persisted state and notify. Drives cross-window sync via the
   * `storage` event; also the boot re-read behind `install`. No write.
   */
  syncFromStorage(): void;
  /** Re-sync from storage at app boot. Idempotent. */
  install(): void;
}

/**
 * Documents the user would recognize as theirs. `/api/pages` serves the whole
 * file index, and the skills-as-content carve-out puts `.ok/skills/**` markdown
 * in it — every `ok init` project ships the `project` skill (a SKILL.md plus
 * seven files under `references/`), so a brand-new empty project already reads
 * as roughly ten "pages". Starter packs land their templates under
 * `<folder>/.ok/templates/` too. Filtering on the `.ok` segment drops both, so
 * the count reflects authored content rather than OK-managed substrate.
 *
 * `hasOkPathSegment` is the same predicate the file tree uses to decide what is
 * OK-managed — one definition, so the count and the tree can't disagree.
 */
export function countUserDocuments(pages: ReadonlySet<string>): number {
  let count = 0;
  for (const docName of pages) {
    if (!hasOkPathSegment(docName)) count++;
  }
  return count;
}

/**
 * True when the card should take its one session: the user hasn't answered, it
 * has never shown, the two-week clock has run, and the workspace holds enough
 * documents.
 *
 * Pure — `now` and `docCount` are injected so the boundaries are testable and
 * so no caller can accidentally evaluate against a clock the tests can't move.
 */
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

/**
 * Epoch-ms coercion. Rejects NaN/Infinity and non-positive values: a corrupt
 * `0` or negative timestamp would read as "first seen at the epoch" and make
 * the two-week gate pass instantly.
 */
function asEpochMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Coerce arbitrary parsed JSON into a valid state. Every field defaults safely
 * so partial, corrupt, or forward/backward-incompatible payloads degrade rather
 * than throw.
 */
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
    // Absent / throwing localStorage (SSR, Safari private mode, sandboxed
    // iframe) or corrupt JSON — fall back to defaults so module init never
    // crashes.
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
    // Quota exceeded / privacy mode / SSR — in-memory state holds for the session.
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
    // Adopt whatever another window (or the boot re-read) persisted. Notify
    // unconditionally — a no-op notify is cheap, and skipping it would need a
    // deep compare of the state we just read.
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
      // Re-read at boot in case the singleton was constructed before storage
      // was reachable (module graph import order).
      syncFromStorage();
    },
  };
}

export const feedbackNudgeStore: FeedbackNudgeStore = createFeedbackNudgeStore();

// Cross-window sync: when another window writes the nudge key, adopt it here so
// a dismiss over there clears the card here without a reload. The `storage`
// event only fires in OTHER windows, so the writing window is already current
// via its own `commit`. `event.key === null` covers `localStorage.clear()`.
// Mirrors `enabled-agents` / `registered-agents`.
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
