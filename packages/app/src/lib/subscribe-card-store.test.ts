import { describe, expect, test } from 'bun:test';
import {
  createSubscribeCardStore,
  DEFAULT_SUBSCRIBE_CARD_STATE,
  isSubscribeCombinedEligible,
  MAX_SUBSCRIBE_CARD_SHOWS,
  readPersistedState,
  SUBSCRIBE_CARD_STORAGE_KEY,
  type SubscribeCardState,
  type SubscribeCardStorage,
  writePersistedState,
} from './subscribe-card-store.ts';

function memoryStorage(initial: Record<string, string> = {}): SubscribeCardStorage & {
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
      return data.get(SUBSCRIBE_CARD_STORAGE_KEY) ?? null;
    },
  };
}

function stateWith(overrides: Partial<SubscribeCardState>): SubscribeCardState {
  return { ...DEFAULT_SUBSCRIBE_CARD_STATE, ...overrides };
}

describe('readPersistedState', () => {
  test('absent key returns default', () => {
    expect(readPersistedState(memoryStorage())).toEqual(DEFAULT_SUBSCRIBE_CARD_STATE);
  });

  test('round-trips the durable fields', () => {
    const stored = { subscribed: true, dismissed: false, shownVersions: ['1.0.0', '1.1.0'] };
    const s = memoryStorage({ [SUBSCRIBE_CARD_STORAGE_KEY]: JSON.stringify(stored) });
    expect(readPersistedState(s)).toEqual(stored);
  });

  test('non-array shownVersions and non-string entries coerce safely', () => {
    const s = memoryStorage({
      [SUBSCRIBE_CARD_STORAGE_KEY]: JSON.stringify({
        subscribed: 'yes',
        dismissed: 1,
        shownVersions: 'nope',
      }),
    });
    expect(readPersistedState(s)).toEqual({
      subscribed: false,
      dismissed: false,
      shownVersions: [],
    });

    const s2 = memoryStorage({
      [SUBSCRIBE_CARD_STORAGE_KEY]: JSON.stringify({ shownVersions: ['1.0.0', 2, null, '1.1.0'] }),
    });
    expect(readPersistedState(s2).shownVersions).toEqual(['1.0.0', '1.1.0']);
  });

  test('corrupt JSON falls back to default', () => {
    const s = memoryStorage({ [SUBSCRIBE_CARD_STORAGE_KEY]: '{not valid json' });
    expect(readPersistedState(s)).toEqual(DEFAULT_SUBSCRIBE_CARD_STATE);
  });
});

describe('writePersistedState', () => {
  test('persists the state verbatim', () => {
    const s = memoryStorage();
    writePersistedState({ subscribed: false, dismissed: true, shownVersions: ['9.9.9'] }, s);
    expect(JSON.parse(s.raw() as string)).toEqual({
      subscribed: false,
      dismissed: true,
      shownVersions: ['9.9.9'],
    });
  });
});

describe('isSubscribeCombinedEligible', () => {
  test('eligible for a fresh version when not subscribed/dismissed and under budget', () => {
    expect(isSubscribeCombinedEligible(DEFAULT_SUBSCRIBE_CARD_STATE, '1.0.0')).toBe(true);
  });

  test('not eligible once subscribed or dismissed', () => {
    expect(isSubscribeCombinedEligible(stateWith({ subscribed: true }), '1.0.0')).toBe(false);
    expect(isSubscribeCombinedEligible(stateWith({ dismissed: true }), '1.0.0')).toBe(false);
  });

  test('not eligible for a version already shown (no re-nag on reopen)', () => {
    expect(isSubscribeCombinedEligible(stateWith({ shownVersions: ['1.0.0'] }), '1.0.0')).toBe(
      false,
    );
    // ...but still eligible for a different version (within budget)
    expect(isSubscribeCombinedEligible(stateWith({ shownVersions: ['1.0.0'] }), '1.1.0')).toBe(
      true,
    );
  });

  test('not eligible once the version budget is spent', () => {
    const spent = stateWith({ shownVersions: ['1.0.0', '1.1.0', '1.2.0'] });
    expect(spent.shownVersions.length).toBe(MAX_SUBSCRIBE_CARD_SHOWS);
    expect(isSubscribeCombinedEligible(spent, '1.3.0')).toBe(false);
  });
});

describe('createSubscribeCardStore', () => {
  test('markSubscribed latches and is idempotent', () => {
    const s = memoryStorage();
    const store = createSubscribeCardStore(s);
    store.markSubscribed();
    store.markSubscribed();
    expect(store.getSnapshot().subscribed).toBe(true);
    expect(JSON.parse(s.raw() as string).subscribed).toBe(true);
  });

  test('dismiss latches and is idempotent', () => {
    const store = createSubscribeCardStore(memoryStorage());
    store.dismiss();
    store.dismiss();
    expect(store.getSnapshot().dismissed).toBe(true);
  });

  test('recordShown appends a version once; distinct versions accumulate', () => {
    const s = memoryStorage();
    const store = createSubscribeCardStore(s);
    store.recordShown('1.0.0');
    store.recordShown('1.0.0'); // idempotent per version
    store.recordShown('1.1.0');
    expect(store.getSnapshot().shownVersions).toEqual(['1.0.0', '1.1.0']);
    expect(JSON.parse(s.raw() as string).shownVersions).toEqual(['1.0.0', '1.1.0']);
  });

  test('persisted shownVersions survive a fresh store over the same storage', () => {
    const s = memoryStorage();
    createSubscribeCardStore(s).recordShown('1.0.0');
    const store2 = createSubscribeCardStore(s);
    expect(store2.getSnapshot().shownVersions).toEqual(['1.0.0']);
    // A reopen on the same version is no longer eligible; a new version is.
    expect(isSubscribeCombinedEligible(store2.getSnapshot(), '1.0.0')).toBe(false);
    expect(isSubscribeCombinedEligible(store2.getSnapshot(), '2.0.0')).toBe(true);
  });

  test('subscribe notifies listeners', () => {
    const store = createSubscribeCardStore(memoryStorage());
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls++;
    });
    store.markSubscribed();
    store.markSubscribed(); // idempotent — no second notify
    unsub();
    store.dismiss(); // after unsub — not counted
    expect(calls).toBe(1);
  });
});
