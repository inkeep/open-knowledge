/**
 * UpdateNotices — module-level store for persistent auto-updater notices.
 *
 * Why a module-level store instead of React state inside the component:
 *
 * The renderer's `<UpdateNotices />` lives inside the shadcn Sidebar tree,
 * which remounts transparently across theme toggles, sidebar width changes,
 * and other parent-triggered re-mounts we don't control. A subscriber
 * attached inside `useEffect(() => ..., [])` detaches on every unmount and
 * re-attaches on re-mount — and between those moments, any IPC event main
 * sends is dropped on the floor.
 *
 * Moving the bridge subscription to module-init time (before React mounts)
 * solves both halves of the problem:
 *   1. Subscribers attach ONCE per window-lifetime, independent of how
 *      many times UpdateNotices mounts.
 *   2. IPC events landing before React even renders are captured — the
 *      store holds the notices until something consumes them.
 *
 * The component reads state via `useSyncExternalStore`, which is React's
 * canonical path for module-level external stores.
 *
 * Main.tsx imports this file for its side effect. Web/CLI distribution
 * skips the subscribe call because `window.okDesktop` is undefined there.
 */

import {
  addSchemaIncompatibilityNotice,
  attachUpdateSubscribers,
  type UpdateNotice,
} from '@/components/UpdateNotices.shared';
import { isSubscribeCombinedEligible, subscribeCardStore } from '@/lib/subscribe-card-store';

let notices: UpdateNotice[] = [];
const listeners = new Set<() => void>();
let attached = false;

function notify(): void {
  for (const l of listeners) l();
}

function addNotice(notice: UpdateNotice): void {
  const idx = notices.findIndex((n) => n.id === notice.id);
  if (idx === -1) {
    notices = [...notices, notice];
  } else {
    const next = notices.slice();
    next[idx] = notice;
    notices = next;
  }
  notify();
}

export function dismissNotice(id: string): void {
  const next = notices.filter((n) => n.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  notify();
}

export function getNoticesSnapshot(): UpdateNotice[] {
  return notices;
}

export function subscribeToNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Install the module-init-time bridge subscription. Idempotent — a second
 * call is a no-op so HMR re-evaluation doesn't stack subscribers. Runs in
 * the renderer at `main.tsx`'s module-load side effect, before React mounts.
 */
export function installUpdateNoticesBridge(): void {
  if (attached) return;
  if (typeof window === 'undefined') return;
  const bridge = window.okDesktop;
  if (!bridge) return;
  attached = true;
  attachUpdateSubscribers(bridge, addNotice, dismissNotice, undefined, {
    // Add the subscribe prompt to a what's-new card when device-local state
    // allows it; recording the show keeps a same-version reopen from re-nagging
    // and counts against the 3-version budget.
    isEligible: (version) => isSubscribeCombinedEligible(subscribeCardStore.getSnapshot(), version),
    onShown: (version) => subscribeCardStore.recordShown(version),
  });
  // Boot-time refuse-downgrade pickup. Newly-opened windows that missed an
  // earlier action also pick up the diagnostic via this query — main clears
  // it once the user takes Reset or Stay-on-Beta. Query rejections are not
  // surfaced to the user (boot guard re-fires from disk on next launch);
  // logging keeps the failure observable for diagnostics — silent rejection
  // would mask a regression in the bridge wiring that bypasses the entire
  // refuse-downgrade UX for the session.
  bridge.state.query().then(
    (snapshot) => {
      if (snapshot.schemaIncompatibility) {
        addSchemaIncompatibilityNotice(
          bridge,
          snapshot.schemaIncompatibility,
          addNotice,
          dismissNotice,
        );
      }
    },
    (err: unknown) => {
      console.warn('[update-notices-store] bridge.state.query() failed', err);
    },
  );
}
