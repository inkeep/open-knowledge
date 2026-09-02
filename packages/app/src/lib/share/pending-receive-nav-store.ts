import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import { docNameFromHash, isContentRootHash } from '@/lib/doc-hash';
import { normalizeDocNameInput } from '@/lib/doc-paths';

export interface PendingReceiveNav {
  readonly kind: 'doc' | 'folder';
  readonly path: string;
  readonly repositoryPath?: string;
  readonly contentRootDepth?: number;
  readonly branch: string | null;
}

export interface PendingReceiveNavStore {
  arm(nav: PendingReceiveNav): void;
  clear(): void;
  getSnapshot(): PendingReceiveNav | null;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

function normalizeFolder(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

export function hashSelectsPendingNav(hash: string, armed: PendingReceiveNav): boolean {
  if (armed.kind === 'folder') {
    if (isContentRootHash(hash)) return normalizeFolder(armed.path) === '';
    const docName = docNameFromHash(hash);
    return docName !== null && normalizeFolder(docName) === normalizeFolder(armed.path);
  }
  const docName = docNameFromHash(hash);
  if (docName === null) return false;
  return normalizeDocNameInput(docName) === normalizeDocNameInput(armed.path);
}

export function createPendingReceiveNavStore(): PendingReceiveNavStore {
  let current: PendingReceiveNav | null = null;
  const listeners = new Set<() => void>();
  let hashListenerAttached = false;

  function notify(): void {
    for (const l of listeners) l();
  }

  function setCurrent(next: PendingReceiveNav | null): void {
    if (current === next) return;
    current = next;
    notify();
  }

  function onHashChange(): void {
    if (current === null) return;
    if (hashSelectsPendingNav(window.location.hash, current)) return;
    setCurrent(null);
  }

  function ensureHashListener(): void {
    if (hashListenerAttached || typeof window === 'undefined') return;
    hashListenerAttached = true;
    window.addEventListener('hashchange', onHashChange);
  }

  return {
    arm(nav): void {
      ensureHashListener();
      setCurrent(nav);
    },
    clear(): void {
      setCurrent(null);
    },
    getSnapshot(): PendingReceiveNav | null {
      return current;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (hashListenerAttached && typeof window !== 'undefined') {
        window.removeEventListener('hashchange', onHashChange);
        hashListenerAttached = false;
      }
      setCurrent(null);
    },
  };
}

export const pendingReceiveNavStore: PendingReceiveNavStore = createPendingReceiveNavStore();

export function pendingReceiveNavForContentPath(
  nav: PendingReceiveNav,
  path: string,
): PendingReceiveNav {
  if (nav.contentRootDepth === undefined) {
    return { ...nav, path, repositoryPath: path };
  }
  const repositoryPath = nav.repositoryPath ?? nav.path;
  const prefix = repositoryPath.split('/').slice(0, nav.contentRootDepth);
  return {
    ...nav,
    path,
    repositoryPath: [...prefix, ...(path === '' ? [] : path.split('/'))].join('/'),
  };
}

export function matchesShareReceiveMiss(
  activeTarget: ResolvedNavigationTarget | null,
  armed: PendingReceiveNav | null,
): PendingReceiveNav | null {
  if (activeTarget === null || activeTarget.kind !== 'missing') return null;
  if (armed === null || normalizeDocNameInput(armed.path) !== activeTarget.target) return null;
  return armed;
}
