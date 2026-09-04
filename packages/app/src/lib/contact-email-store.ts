export const CONTACT_EMAIL_STORAGE_KEY = 'ok-contact-email-v1';

export const CONTACT_EMAIL_MAX_LENGTH = 320;

export interface ContactEmailState {
  readonly email: string | null;
}

export const DEFAULT_CONTACT_EMAIL_STATE: ContactEmailState = { email: null };

export interface ContactEmailStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ContactEmailStore {
  getSnapshot(): ContactEmailState;
  subscribe(listener: () => void): () => void;
  remember(email: string): void;
  forget(): void;
  syncFromStorage(): void;
  install(): void;
}

function asStoredEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > CONTACT_EMAIL_MAX_LENGTH) return null;
  return trimmed;
}

function coerceState(parsed: unknown): ContactEmailState {
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_CONTACT_EMAIL_STATE;
  return { email: asStoredEmail((parsed as Record<string, unknown>).email) };
}

export function readPersistedState(storage?: ContactEmailStorage): ContactEmailState {
  try {
    const s = storage ?? localStorage;
    const raw = s.getItem(CONTACT_EMAIL_STORAGE_KEY);
    if (raw == null) return DEFAULT_CONTACT_EMAIL_STATE;
    return coerceState(JSON.parse(raw));
  } catch (err) {
    console.warn('[contact-email-store] readPersistedState failed (corrupt/privacy/SSR)', err);
    return DEFAULT_CONTACT_EMAIL_STATE;
  }
}

export function writePersistedState(state: ContactEmailState, storage?: ContactEmailStorage): void {
  try {
    const s = storage ?? localStorage;
    s.setItem(CONTACT_EMAIL_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[contact-email-store] writePersistedState failed (quota/privacy/SSR)', err);
  }
}

export function createContactEmailStore(storage?: ContactEmailStorage): ContactEmailStore {
  let state = readPersistedState(storage);
  const listeners = new Set<() => void>();
  let installed = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function commit(next: ContactEmailState): void {
    state = next;
    writePersistedState(state, storage);
    notify();
  }

  function syncFromStorage(): void {
    state = readPersistedState(storage);
    notify();
  }

  return {
    getSnapshot(): ContactEmailState {
      return state;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    remember(email): void {
      const next = asStoredEmail(email);
      if (next === null || next === state.email) return;
      commit({ email: next });
    },

    forget(): void {
      if (state.email === null) return;
      commit({ email: null });
    },

    syncFromStorage,

    install(): void {
      if (installed) return;
      installed = true;
      syncFromStorage();
    },
  };
}

export const contactEmailStore: ContactEmailStore = createContactEmailStore();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === CONTACT_EMAIL_STORAGE_KEY || event.key === null) {
      contactEmailStore.syncFromStorage();
    }
  });
}

export function installContactEmailStore(): void {
  contactEmailStore.install();
}

export function commitContactEmail(
  shareEmail: boolean,
  email: string,
  store: ContactEmailStore = contactEmailStore,
): void {
  if (shareEmail) {
    store.remember(email);
    return;
  }
  store.forget();
}
