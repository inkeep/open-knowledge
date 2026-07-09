import { describe, expect, test } from 'bun:test';
import {
  createOnboardingCardStore,
  DEFAULT_ONBOARDING_CARD_STATE,
  ONBOARDING_CARD_STORAGE_KEY,
  type OnboardingCardStorage,
  readPersistedState,
  writePersistedState,
} from './onboarding-card-store.ts';

function memoryStorage(initial: Record<string, string> = {}): OnboardingCardStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

describe('readPersistedState', () => {
  test('absent key returns default', () => {
    expect(readPersistedState(memoryStorage())).toEqual(DEFAULT_ONBOARDING_CARD_STATE);
  });

  test('round-trips a fully populated state', () => {
    const stored = {
      initialized: true,
      steps: { file: true, askedAi: true },
      fileBaseline: 3,
      dismissed: false,
      completed: true,
    };
    const s = memoryStorage({ [ONBOARDING_CARD_STORAGE_KEY]: JSON.stringify(stored) });
    expect(readPersistedState(s)).toEqual(stored);
  });

  test('missing fields default to false / baseline 0', () => {
    const s = memoryStorage({
      [ONBOARDING_CARD_STORAGE_KEY]: JSON.stringify({ steps: { file: true } }),
    });
    expect(readPersistedState(s)).toEqual({
      initialized: false,
      steps: { file: true, askedAi: false },
      fileBaseline: 0,
      dismissed: false,
      completed: false,
    });
  });

  test('a non-numeric / negative fileBaseline coerces to 0', () => {
    for (const bad of ['5', -2, Number.NaN, null, {}]) {
      const s = memoryStorage({
        [ONBOARDING_CARD_STORAGE_KEY]: JSON.stringify({ initialized: true, fileBaseline: bad }),
      });
      expect(readPersistedState(s).fileBaseline).toBe(0);
    }
  });

  test('non-boolean field values are coerced to false', () => {
    const s = memoryStorage({
      [ONBOARDING_CARD_STORAGE_KEY]: JSON.stringify({
        dismissed: 'yes',
        completed: 1,
        steps: { file: 'true', askedAi: null },
      }),
    });
    const read = readPersistedState(s);
    expect(read.dismissed).toBe(false);
    expect(read.completed).toBe(false);
    expect(read.steps).toEqual({ file: false, askedAi: false });
  });

  test('corrupt JSON falls back to default', () => {
    const s = memoryStorage({ [ONBOARDING_CARD_STORAGE_KEY]: '{not valid json' });
    expect(readPersistedState(s)).toEqual(DEFAULT_ONBOARDING_CARD_STATE);
  });

  test('non-object JSON falls back to default', () => {
    const s = memoryStorage({ [ONBOARDING_CARD_STORAGE_KEY]: '"a string"' });
    expect(readPersistedState(s)).toEqual(DEFAULT_ONBOARDING_CARD_STATE);
  });

  // Browser-storage trust boundary: localStorage.getItem can throw SecurityError
  // in Safari private browsing (and equivalent modes). The read try/catch is the
  // producer-cannot-enforce surface for that throw — pin the fallback via the
  // public storage seam (real failure-inducing input through the public interface).
  test('returns default when getItem throws (SecurityError / private browsing)', () => {
    const throwingStorage: OnboardingCardStorage = {
      getItem: () => {
        throw new DOMException('SecurityError');
      },
      setItem: () => {},
    };
    expect(readPersistedState(throwingStorage)).toEqual(DEFAULT_ONBOARDING_CARD_STATE);
  });
});

describe('writePersistedState', () => {
  test('a written state reads back identically (reload round-trip)', () => {
    const s = memoryStorage();
    const next = { ...DEFAULT_ONBOARDING_CARD_STATE, dismissed: true, completed: true };
    writePersistedState(next, s);
    expect(readPersistedState(s)).toEqual(next);
  });

  // Browser-storage trust boundary: setItem throws QuotaExceededError when origin
  // storage is full. The write try/catch lets the session keep working — pin that
  // it does not propagate, via the public storage seam.
  test('does not throw when setItem throws (quota exceeded)', () => {
    const throwingStorage: OnboardingCardStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    };
    expect(() => writePersistedState(DEFAULT_ONBOARDING_CARD_STATE, throwingStorage)).not.toThrow();
  });
});

describe('createOnboardingCardStore — mutations', () => {
  test('markStepComplete checks the named step', () => {
    const store = createOnboardingCardStore(memoryStorage());
    store.markStepComplete('file');
    expect(store.getSnapshot().steps).toEqual({ file: true, askedAi: false });
  });

  test('steps are independent', () => {
    const store = createOnboardingCardStore(memoryStorage());
    store.markStepComplete('askedAi');
    expect(store.getSnapshot().steps).toEqual({ file: false, askedAi: true });
  });

  test('activate latches initialized', () => {
    const store = createOnboardingCardStore(memoryStorage());
    expect(store.getSnapshot().initialized).toBe(false);
    store.activate();
    expect(store.getSnapshot().initialized).toBe(true);
  });

  test('activate records the file baseline (defaults to 0)', () => {
    const store = createOnboardingCardStore(memoryStorage());
    store.activate(4);
    expect(store.getSnapshot().fileBaseline).toBe(4);

    const blank = createOnboardingCardStore(memoryStorage());
    blank.activate();
    expect(blank.getSnapshot().fileBaseline).toBe(0);
  });

  test('activate is idempotent — the first baseline wins', () => {
    const store = createOnboardingCardStore(memoryStorage());
    store.activate(4);
    store.activate(9);
    expect(store.getSnapshot().fileBaseline).toBe(4);
  });

  test('dismiss sets the dismissed flag', () => {
    const store = createOnboardingCardStore(memoryStorage());
    store.dismiss();
    expect(store.getSnapshot().dismissed).toBe(true);
  });

  test('markCompleted sets the completed flag', () => {
    const store = createOnboardingCardStore(memoryStorage());
    store.markCompleted();
    expect(store.getSnapshot().completed).toBe(true);
  });
});

describe('createOnboardingCardStore — persistence across remount', () => {
  test('dismiss persists so a fresh store reads it back true', () => {
    const shared = memoryStorage();
    createOnboardingCardStore(shared).dismiss();
    // A fresh store over the same storage simulates a reload / new module read.
    expect(createOnboardingCardStore(shared).getSnapshot().dismissed).toBe(true);
  });

  test('markCompleted persists so a fresh store reads it back true', () => {
    const shared = memoryStorage();
    createOnboardingCardStore(shared).markCompleted();
    expect(createOnboardingCardStore(shared).getSnapshot().completed).toBe(true);
  });

  test('step completion persists across remount', () => {
    const shared = memoryStorage();
    createOnboardingCardStore(shared).markStepComplete('file');
    expect(createOnboardingCardStore(shared).getSnapshot().steps.file).toBe(true);
  });

  test('completion state persists across remount', () => {
    const shared = memoryStorage();
    createOnboardingCardStore(shared).markCompleted();
    expect(createOnboardingCardStore(shared).getSnapshot().completed).toBe(true);
  });
});

describe('createOnboardingCardStore — idempotence', () => {
  test('markStepComplete twice does not notify the second time', () => {
    const store = createOnboardingCardStore(memoryStorage());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.markStepComplete('file');
    store.markStepComplete('file');
    expect(notifications).toBe(1);
    expect(store.getSnapshot().steps.file).toBe(true);
  });

  test('dismiss twice does not notify the second time', () => {
    const store = createOnboardingCardStore(memoryStorage());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.dismiss();
    store.dismiss();
    expect(notifications).toBe(1);
  });

  test('activate twice does not notify the second time', () => {
    const store = createOnboardingCardStore(memoryStorage());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.activate();
    store.activate();
    expect(notifications).toBe(1);
  });

  test('markStepComplete for an already-complete step is a no-op', () => {
    const store = createOnboardingCardStore(memoryStorage());
    store.markStepComplete('file');
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.markStepComplete('file');
    expect(notifications).toBe(0);
  });
});

describe('createOnboardingCardStore — subscription', () => {
  test('a subscribed listener is notified on mutation', () => {
    const store = createOnboardingCardStore(memoryStorage());
    let notified = false;
    store.subscribe(() => {
      notified = true;
    });
    store.markStepComplete('askedAi');
    expect(notified).toBe(true);
  });

  test('an unsubscribed listener is not notified', () => {
    const store = createOnboardingCardStore(memoryStorage());
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    unsubscribe();
    store.dismiss();
    expect(notifications).toBe(0);
  });

  test('getSnapshot returns a stable reference until a mutation occurs', () => {
    const store = createOnboardingCardStore(memoryStorage());
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.markStepComplete('file');
    expect(store.getSnapshot()).not.toBe(first);
  });
});

describe('createOnboardingCardStore — install', () => {
  test('install re-syncs from storage seeded after construction', () => {
    const shared = memoryStorage();
    const store = createOnboardingCardStore(shared);
    expect(store.getSnapshot().dismissed).toBe(false);
    shared.setItem(
      ONBOARDING_CARD_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_ONBOARDING_CARD_STATE, dismissed: true }),
    );
    store.install();
    expect(store.getSnapshot().dismissed).toBe(true);
  });

  test('install is idempotent — a second call does not re-sync', () => {
    const shared = memoryStorage();
    const store = createOnboardingCardStore(shared);
    store.install();
    shared.setItem(
      ONBOARDING_CARD_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_ONBOARDING_CARD_STATE, completed: true }),
    );
    store.install();
    expect(store.getSnapshot().completed).toBe(false);
  });

  test('install notifies subscribers when it re-syncs', () => {
    const shared = memoryStorage();
    const store = createOnboardingCardStore(shared);
    let notified = false;
    store.subscribe(() => {
      notified = true;
    });
    store.install();
    expect(notified).toBe(true);
  });

  // SSR-safety: the default-storage path must not throw when localStorage is
  // unreachable. In the Bun unit runtime `window` is undefined, so constructing
  // and installing the real-storage store directly exercises that path.
  test('construct + install over the default storage path does not throw', () => {
    expect(() => createOnboardingCardStore().install()).not.toThrow();
  });
});
