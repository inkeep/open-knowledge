export type AuthPromptStep = 'auth' | 'identity';

export interface AuthPromptStore {
  request(step?: AuthPromptStep): void;
  clear(): void;
  getSnapshot(): AuthPromptStep | null;
  subscribe(listener: () => void): () => void;
}

function createAuthPromptStore(): AuthPromptStore {
  let pending: AuthPromptStep | null = null;
  const listeners = new Set<() => void>();

  function set(next: AuthPromptStep | null): void {
    if (pending === next) return;
    pending = next;
    for (const l of listeners) l();
  }

  return {
    request(step: AuthPromptStep = 'auth'): void {
      set(step);
    },
    clear(): void {
      set(null);
    },
    getSnapshot(): AuthPromptStep | null {
      return pending;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const authPromptStore: AuthPromptStore = createAuthPromptStore();
