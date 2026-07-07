/**
 * Renderer store for the pending share-receive navigation.
 *
 * A share-receive deep link (desktop) navigates the window to the shared
 * doc. When that navigation lands on a path the branch doesn't carry, the
 * resolver returns `{ kind: 'missing' }` and the editor would otherwise open
 * create-mode — the "type here and silently fork the doc at the shared path"
 * trap. The renderer can't tell that miss apart from an ordinary wiki-link
 * create-on-navigate by the target alone (both are `missing`); this store
 * carries the provenance that distinguishes them, so EditorArea renders an
 * honest terminal panel for a share-receive miss and leaves wiki-link
 * create-on-navigate untouched.
 *
 * Armed by the deep-link listener right before it sets the hash, and
 * self-clears on the first hashchange that leaves the armed target — keyed to
 * the hash (the navigation source of truth) rather than React render timing,
 * so arming can't race a stale render into clearing itself, and a later
 * wiki-link to the same path is create-on-navigate again. Mirrors the
 * `receive-store` singleton + `useSyncExternalStore` pattern.
 */

import {
  normalizeTargetPath,
  type ResolvedNavigationTarget,
} from '@/components/navigation-targets';
import { docNameFromHash, isContentRootHash } from '@/lib/doc-hash';

export interface PendingReceiveNav {
  readonly kind: 'doc' | 'folder';
  /**
   * The share target path as delivered — the file extension is preserved so the
   * target-status verdict fetch queries the real repo file (a stripped docName
   * makes every `.md` share miss look `never-on-branch`). The miss matcher and
   * the self-clear normalize it to compare against the resolver's
   * extension-stripped `activeTarget.target`.
   */
  readonly path: string;
  /** Share branch the target-status verdict fetch keys off; null on legacy branch-less shares. */
  readonly branch: string | null;
}

export interface PendingReceiveNavStore {
  arm(nav: PendingReceiveNav): void;
  clear(): void;
  getSnapshot(): PendingReceiveNav | null;
  subscribe(listener: () => void): () => void;
  /** Test-only teardown: detach the hashchange listener the store installs on first arm. */
  dispose(): void;
}

function normalizeFolder(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * True while `hash` still selects `armed`'s target. Doc: the hash's docName
 * (the `?branch=` query stripped by `docNameFromHash`) equals the armed path.
 * Folder: the trailing-slash form (or the `#/` content-root sentinel) resolves
 * to the same folder. Drives the self-clear — a hashchange that no longer
 * selects the armed target has navigated away, so the pending nav is stale.
 */
export function hashSelectsPendingNav(hash: string, armed: PendingReceiveNav): boolean {
  if (armed.kind === 'folder') {
    if (isContentRootHash(hash)) return normalizeFolder(armed.path) === '';
    const docName = docNameFromHash(hash);
    return docName !== null && normalizeFolder(docName) === normalizeFolder(armed.path);
  }
  const docName = docNameFromHash(hash);
  if (docName === null) return false;
  // Both sides carry the file extension a real share target has (`armed.path` as
  // delivered, the hash as encoded), while the resolver strips it — so normalize
  // both to the same extension-stripped form. Without this the store self-clears
  // on its own arming navigation and the miss guard never fires.
  return (
    normalizeTargetPath(docName).normalizedTarget ===
    normalizeTargetPath(armed.path).normalizedTarget
  );
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

/** Module-level singleton — the deep-link listener arms it, EditorArea reads it. */
export const pendingReceiveNavStore: PendingReceiveNavStore = createPendingReceiveNavStore();

/**
 * The pending share-receive nav the editor should render as an honest miss
 * panel instead of create-mode, or null when the active target isn't a
 * share-receive miss. Pure: a target qualifies only when the resolver marked
 * it `missing` AND its path matches the armed pending nav. A missing target
 * with no armed nav — an ordinary wiki-link create-on-navigate — returns null,
 * so create-mode stays reachable for those (the fork-trap fix is scoped to
 * share-receive navigation).
 */
export function matchesShareReceiveMiss(
  activeTarget: ResolvedNavigationTarget | null,
  armed: PendingReceiveNav | null,
): PendingReceiveNav | null {
  if (activeTarget === null || activeTarget.kind !== 'missing') return null;
  // `armed.path` keeps the share target's extension; `activeTarget.target` is the
  // resolver's stripped form — normalize before comparing.
  if (armed === null || normalizeTargetPath(armed.path).normalizedTarget !== activeTarget.target)
    return null;
  return armed;
}
