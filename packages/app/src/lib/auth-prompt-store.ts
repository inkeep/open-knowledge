/**
 * Renderer store for "something needs the user to sign in to GitHub".
 *
 * The AuthModal is owned locally by the surfaces that host it (EditorPane,
 * NavigatorApp) and opened from their own chrome. Surfaces that are mounted
 * elsewhere in the tree — `ShareBranchSwitchDialog` self-gates on the share
 * store under App, with no prop path to EditorPane's modal state — need a way
 * to ask for it without lifting that state through the whole tree.
 *
 * Same module-singleton + `useSyncExternalStore` shape as `miss-dialog-store`
 * and `receive-store`. `request()` arms it, the hosting surface opens its modal
 * and calls `clear()`.
 */

export interface AuthPromptStore {
  /** Ask the hosting surface to open the GitHub sign-in modal. */
  request(): void;
  /** Called by the host once it has opened the modal. */
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
