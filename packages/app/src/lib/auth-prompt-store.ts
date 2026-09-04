export interface AuthPromptStore {
  request(): void;
  clear(): void;
  getSnapshot(): boolean;
  subscribe(listener: () => void): () => void;
}

function createAuthPromptStore(): AuthPromptStore {
  let pending = false;
  const listeners = new Set<() => void>();

  function set(next: boolean): void {
    if (pending === next) return;
    pending = next;
    for (const l of listeners) l();
  }

  return {
    request(): void {
      set(true);
    },
    clear(): void {
      set(false);
    },
    getSnapshot(): boolean {
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
