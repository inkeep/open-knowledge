import { describe, expect, test, vi } from 'vitest';
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_EMAIL_STORAGE_KEY,
  type ContactEmailStorage,
  commitContactEmail,
  createContactEmailStore,
  DEFAULT_CONTACT_EMAIL_STATE,
  readPersistedState,
  writePersistedState,
} from './contact-email-store.ts';

function memoryStorage(initial: Record<string, string> = {}): ContactEmailStorage & {
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
      return data.get(CONTACT_EMAIL_STORAGE_KEY) ?? null;
    },
  };
}

function refusingStorage(): ContactEmailStorage {
  return {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
}

describe('readPersistedState', () => {
  test('absent key returns default', () => {
    expect(readPersistedState(memoryStorage())).toEqual(DEFAULT_CONTACT_EMAIL_STATE);
  });

  test('round-trips a stored address', () => {
    const s = memoryStorage({
      [CONTACT_EMAIL_STORAGE_KEY]: JSON.stringify({ email: 'me@example.com' }),
    });
    expect(readPersistedState(s)).toEqual({ email: 'me@example.com' });
  });

  test('non-string, empty, and over-long values coerce to null', () => {
    for (const email of [42, {}, null, '', '   ', 'x'.repeat(CONTACT_EMAIL_MAX_LENGTH + 1)]) {
      const s = memoryStorage({ [CONTACT_EMAIL_STORAGE_KEY]: JSON.stringify({ email }) });
      expect(readPersistedState(s)).toEqual(DEFAULT_CONTACT_EMAIL_STATE);
    }
  });

  test('corrupt JSON returns default without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = memoryStorage({ [CONTACT_EMAIL_STORAGE_KEY]: '{not json' });
    expect(readPersistedState(s)).toEqual(DEFAULT_CONTACT_EMAIL_STATE);
    warn.mockRestore();
  });
});

describe('writePersistedState', () => {
  test('writes the state verbatim', () => {
    const s = memoryStorage();
    writePersistedState({ email: 'me@example.com' }, s);
    expect(s.raw()).toBe(JSON.stringify({ email: 'me@example.com' }));
  });
});

describe('storage that refuses to write', () => {
  test('a write failure does not propagate and the store keeps the value in memory', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createContactEmailStore(refusingStorage());
    expect(() => store.remember('me@example.com')).not.toThrow();
    expect(store.getSnapshot().email).toBe('me@example.com');
    warn.mockRestore();
  });
});

describe('createContactEmailStore', () => {
  test('remember trims and persists; a fresh store over the same storage sees it', () => {
    const shared = memoryStorage();
    createContactEmailStore(shared).remember('  me@example.com  ');
    expect(createContactEmailStore(shared).getSnapshot().email).toBe('me@example.com');
  });

  test('remember ignores blank and over-long values', () => {
    const store = createContactEmailStore(memoryStorage());
    store.remember('   ');
    expect(store.getSnapshot().email).toBeNull();
    store.remember('x'.repeat(CONTACT_EMAIL_MAX_LENGTH + 1));
    expect(store.getSnapshot().email).toBeNull();
  });

  test('forget clears the address, and nothing survives a fresh store', () => {
    const shared = memoryStorage();
    const store = createContactEmailStore(shared);
    store.remember('me@example.com');
    store.forget();
    expect(store.getSnapshot().email).toBeNull();
    expect(createContactEmailStore(shared).getSnapshot().email).toBeNull();
  });

  test('subscribe notifies on real transitions only', () => {
    const store = createContactEmailStore(memoryStorage());
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls++;
    });
    store.remember('me@example.com');
    store.remember('me@example.com');
    store.forget();
    store.forget();
    unsub();
    store.remember('other@example.com');
    expect(calls).toBe(2);
  });

  test('install re-reads storage written after construction', () => {
    const s = memoryStorage();
    const store = createContactEmailStore(s);
    expect(store.getSnapshot().email).toBeNull();
    writePersistedState({ email: 'me@example.com' }, s);
    store.install();
    expect(store.getSnapshot().email).toBe('me@example.com');
  });

  test('syncFromStorage adopts another window write and notifies', () => {
    const shared = memoryStorage();
    const thisWindow = createContactEmailStore(shared);
    let notified = 0;
    thisWindow.subscribe(() => {
      notified++;
    });

    const otherWindow = createContactEmailStore(shared);
    otherWindow.remember('me@example.com');

    thisWindow.syncFromStorage();
    expect(thisWindow.getSnapshot().email).toBe('me@example.com');
    expect(notified).toBeGreaterThan(0);
  });

  test('syncFromStorage adopts another window forget', () => {
    const shared = memoryStorage();
    const thisWindow = createContactEmailStore(shared);
    thisWindow.remember('me@example.com');

    const otherWindow = createContactEmailStore(shared);
    otherWindow.forget();

    thisWindow.syncFromStorage();
    expect(thisWindow.getSnapshot().email).toBeNull();
  });
});

describe('commitContactEmail', () => {
  test('a checked box remembers the address', () => {
    const shared = memoryStorage();
    const store = createContactEmailStore(shared);
    commitContactEmail(true, 'me@example.com', store);
    expect(createContactEmailStore(shared).getSnapshot().email).toBe('me@example.com');
  });

  test('an unchecked box forgets a previously stored address', () => {
    const shared = memoryStorage();
    const store = createContactEmailStore(shared);
    commitContactEmail(true, 'me@example.com', store);
    commitContactEmail(false, 'me@example.com', store);
    expect(createContactEmailStore(shared).getSnapshot().email).toBeNull();
  });
});
