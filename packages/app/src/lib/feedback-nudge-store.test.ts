import { describe, expect, test } from 'vitest';
import {
  countUserDocuments,
  createFeedbackNudgeStore,
  DEFAULT_FEEDBACK_NUDGE_STATE,
  FEEDBACK_NUDGE_MIN_AGE_MS,
  FEEDBACK_NUDGE_MIN_DOCS,
  FEEDBACK_NUDGE_STORAGE_KEY,
  type FeedbackNudgeState,
  type FeedbackNudgeStorage,
  isFeedbackNudgeEligible,
  readPersistedState,
  writePersistedState,
} from './feedback-nudge-store.ts';

function memoryStorage(initial: Record<string, string> = {}): FeedbackNudgeStorage & {
  raw(): string | null;
} {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    raw() {
      return data.get(FEEDBACK_NUDGE_STORAGE_KEY) ?? null;
    },
  };
}

function stateWith(overrides: Partial<FeedbackNudgeState>): FeedbackNudgeState {
  return { ...DEFAULT_FEEDBACK_NUDGE_STATE, ...overrides };
}

const NOW = 1_800_000_000_000;
/** A `firstSeenAt` exactly on the two-week boundary relative to `NOW`. */
const RIPE = NOW - FEEDBACK_NUDGE_MIN_AGE_MS;

describe('readPersistedState', () => {
  test('absent key returns default', () => {
    expect(readPersistedState(memoryStorage())).toEqual(DEFAULT_FEEDBACK_NUDGE_STATE);
  });

  test('round-trips the durable fields', () => {
    const stored = { firstSeenAt: RIPE, shownAt: NOW, dismissed: true };
    const s = memoryStorage({ [FEEDBACK_NUDGE_STORAGE_KEY]: JSON.stringify(stored) });
    expect(readPersistedState(s)).toEqual(stored);
  });

  test('non-number timestamps and non-boolean flags coerce safely', () => {
    const s = memoryStorage({
      [FEEDBACK_NUDGE_STORAGE_KEY]: JSON.stringify({
        firstSeenAt: '1800000000000',
        shownAt: {},
        dismissed: 1,
      }),
    });
    expect(readPersistedState(s)).toEqual(DEFAULT_FEEDBACK_NUDGE_STATE);
  });

  test('non-positive and non-finite timestamps coerce to null, not to the epoch', () => {
    // A stored `0` would otherwise read as "first seen at the epoch" and make
    // the two-week gate pass on the spot.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = memoryStorage({
        [FEEDBACK_NUDGE_STORAGE_KEY]: JSON.stringify({ firstSeenAt: bad }),
      });
      expect(readPersistedState(s).firstSeenAt).toBeNull();
    }
  });

  test('corrupt JSON falls back to default', () => {
    const s = memoryStorage({ [FEEDBACK_NUDGE_STORAGE_KEY]: '{not valid json' });
    expect(readPersistedState(s)).toEqual(DEFAULT_FEEDBACK_NUDGE_STATE);
  });
});

describe('writePersistedState', () => {
  test('persists the state verbatim', () => {
    const s = memoryStorage();
    writePersistedState({ firstSeenAt: RIPE, shownAt: null, dismissed: true }, s);
    expect(JSON.parse(s.raw() as string)).toEqual({
      firstSeenAt: RIPE,
      shownAt: null,
      dismissed: true,
    });
  });
});

describe('storage that refuses to write', () => {
  // Quota exceeded / Safari private mode / SSR. `FeedbackNudgeStorage` is an
  // injected parameter, so the throw comes from a real collaborator through
  // the public interface rather than a mock inside the try — the assertions
  // are on the promised outcome (the session survives and in-memory state
  // still holds), not on the catch having fired.
  function throwingStorage(): FeedbackNudgeStorage {
    return {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    };
  }

  test('writePersistedState does not propagate the failure', () => {
    expect(() =>
      writePersistedState(DEFAULT_FEEDBACK_NUDGE_STATE, throwingStorage()),
    ).not.toThrow();
  });

  test('the store still records the answer in memory for this session', () => {
    const store = createFeedbackNudgeStore(throwingStorage());

    expect(() => store.dismiss()).not.toThrow();
    // The write was lost, but the user's answer must still hold until reload —
    // otherwise a full-storage device re-shows the nudge within the session.
    expect(store.getSnapshot().dismissed).toBe(true);
    expect(isFeedbackNudgeEligible(store.getSnapshot(), NOW, 400)).toBe(false);
  });
});

describe('countUserDocuments', () => {
  test('counts ordinary docs at any depth', () => {
    expect(countUserDocuments(new Set(['notes', 'brain/ideas', 'a/b/c/deep']))).toBe(3);
  });

  test('excludes the .ok substrate that /api/pages serves alongside real docs', () => {
    const pages = new Set([
      'notes',
      // Skills-as-content: every `ok init` project ships these.
      '.ok/skills/project/SKILL',
      '.ok/skills/project/references/linking',
      // Starter-pack templates land in a nested `.ok/`.
      'brain/.ok/templates/article',
      'brain/.ok/frontmatter',
    ]);
    expect(countUserDocuments(pages)).toBe(1);
  });

  test('case-insensitive on the .ok segment, matching the file-tree predicate', () => {
    expect(countUserDocuments(new Set(['.OK/skills/project/SKILL', 'notes']))).toBe(1);
  });

  test('a doc merely named "ok" is not substrate', () => {
    expect(countUserDocuments(new Set(['ok', 'ok/notes', 'notes.ok']))).toBe(3);
  });

  test('empty set counts zero', () => {
    expect(countUserDocuments(new Set())).toBe(0);
  });
});

describe('isFeedbackNudgeEligible', () => {
  test('eligible once both gates pass', () => {
    expect(
      isFeedbackNudgeEligible(stateWith({ firstSeenAt: RIPE }), NOW, FEEDBACK_NUDGE_MIN_DOCS),
    ).toBe(true);
  });

  test('the default state is never eligible — firstSeenAt has not been stamped', () => {
    expect(isFeedbackNudgeEligible(DEFAULT_FEEDBACK_NUDGE_STATE, NOW, 1000)).toBe(false);
  });

  test('not eligible one millisecond before the two-week boundary', () => {
    expect(
      isFeedbackNudgeEligible(stateWith({ firstSeenAt: RIPE + 1 }), NOW, FEEDBACK_NUDGE_MIN_DOCS),
    ).toBe(false);
  });

  test('not eligible one document below the threshold', () => {
    expect(
      isFeedbackNudgeEligible(stateWith({ firstSeenAt: RIPE }), NOW, FEEDBACK_NUDGE_MIN_DOCS - 1),
    ).toBe(false);
  });

  test('a comfortably old, well-populated workspace is eligible', () => {
    expect(isFeedbackNudgeEligible(stateWith({ firstSeenAt: RIPE - 5_000 }), NOW, 400)).toBe(true);
  });

  test('never eligible once shown, regardless of how ripe the gates are', () => {
    expect(
      isFeedbackNudgeEligible(stateWith({ firstSeenAt: RIPE, shownAt: NOW - 1 }), NOW, 400),
    ).toBe(false);
  });

  test('never eligible once dismissed', () => {
    expect(
      isFeedbackNudgeEligible(stateWith({ firstSeenAt: RIPE, dismissed: true }), NOW, 400),
    ).toBe(false);
  });
});

describe('createFeedbackNudgeStore', () => {
  test('recordFirstSeen stamps once and never moves', () => {
    const s = memoryStorage();
    const store = createFeedbackNudgeStore(s);
    store.recordFirstSeen(NOW);
    store.recordFirstSeen(NOW + 90_000);
    expect(store.getSnapshot().firstSeenAt).toBe(NOW);
    expect(JSON.parse(s.raw() as string).firstSeenAt).toBe(NOW);
  });

  test('recordShown latches once', () => {
    const store = createFeedbackNudgeStore(memoryStorage());
    store.recordShown(NOW);
    store.recordShown(NOW + 90_000);
    expect(store.getSnapshot().shownAt).toBe(NOW);
  });

  test('dismiss latches and is idempotent', () => {
    const store = createFeedbackNudgeStore(memoryStorage());
    store.dismiss();
    store.dismiss();
    expect(store.getSnapshot().dismissed).toBe(true);
  });

  test('a fresh store over the same storage keeps the clock and stays suppressed', () => {
    const s = memoryStorage();
    const first = createFeedbackNudgeStore(s);
    first.recordFirstSeen(RIPE);
    first.recordShown(NOW);

    const second = createFeedbackNudgeStore(s);
    expect(second.getSnapshot().firstSeenAt).toBe(RIPE);
    // The one-shot survives the reload: a new device session does not re-nag.
    expect(isFeedbackNudgeEligible(second.getSnapshot(), NOW, 400)).toBe(false);
  });

  test('subscribe notifies listeners on real transitions only', () => {
    const store = createFeedbackNudgeStore(memoryStorage());
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls++;
    });
    store.recordFirstSeen(NOW);
    store.recordFirstSeen(NOW); // idempotent — no second notify
    unsub();
    store.dismiss(); // after unsub — not counted
    expect(calls).toBe(1);
  });

  test('install re-reads storage written after construction', () => {
    const s = memoryStorage();
    const store = createFeedbackNudgeStore(s);
    expect(store.getSnapshot().firstSeenAt).toBeNull();
    writePersistedState(stateWith({ firstSeenAt: RIPE }), s);
    store.install();
    expect(store.getSnapshot().firstSeenAt).toBe(RIPE);
  });

  test('syncFromStorage adopts another window write and notifies', () => {
    // Cross-window contract: a second window shares this storage. When it
    // dismisses, this window's `storage` handler calls syncFromStorage, and the
    // dismissal must land here so the card can clear without a reload.
    const shared = memoryStorage();
    const thisWindow = createFeedbackNudgeStore(shared);
    let notified = 0;
    thisWindow.subscribe(() => {
      notified++;
    });
    expect(thisWindow.getSnapshot().dismissed).toBe(false);

    const otherWindow = createFeedbackNudgeStore(shared);
    otherWindow.dismiss(); // writes shared storage

    thisWindow.syncFromStorage();
    expect(thisWindow.getSnapshot().dismissed).toBe(true);
    expect(notified).toBeGreaterThan(0);
  });
});
