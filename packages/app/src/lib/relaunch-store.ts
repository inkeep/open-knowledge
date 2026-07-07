/**
 * relaunch-store — module-level reactive store tracking whether a desktop
 * auto-update relaunch is in flight, so renderer surfaces can tell an
 * intentional server teardown apart from a real outage. Consumed today by the
 * file sidebar (calm reconnect notice + self-heal) and the sync-status toast
 * (suppresses its "Connection lost" warning).
 *
 * Why a module-level store (not React state): the signal must be captured even
 * if no subscribed component is mounted at the instant the IPC event fires, and
 * it must survive the sidebar remounts that `update-notices-store` documents.
 * Same shape + rationale as that store — see its header.
 *
 * The flag flips true on `ok:update:relaunching` and clears on
 * `ok:update:relaunch-failed` (the relaunch aborted; the app keeps running and
 * the server is coming back). The main-process handler in
 * `packages/desktop/src/main/auto-updater.ts` broadcasts `relaunching` to every
 * window before it begins the server teardown, so the flag is observable before
 * fetches start failing — but the renderer only relies on the event arriving,
 * not on that ordering, since a late flip self-heals on the next retry.
 *
 * No-op in web/CLI distribution (`window.okDesktop` undefined) — the flag stays
 * false forever, so non-desktop builds keep the unchanged immediate-error UX.
 */

import { useSyncExternalStore } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

let relaunchInFlight = false;
const listeners = new Set<() => void>();
let attached = false;

function notify(): void {
  for (const l of listeners) l();
}

function setInFlight(next: boolean): void {
  if (relaunchInFlight === next) return;
  relaunchInFlight = next;
  notify();
}

export function getRelaunchInFlightSnapshot(): boolean {
  return relaunchInFlight;
}

export function subscribeRelaunchInFlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Pure subscription logic — attach the relaunch lifecycle subscribers on the
 * given bridge and return a single unsubscribe closure. Split from the
 * install side effect so it's testable without a real `window.okDesktop`
 * (mirrors `attachUpdateSubscribers` in `UpdateNotices.shared.ts`).
 */
export function attachRelaunchStateSubscribers(
  bridge: Pick<OkDesktopBridge, 'onUpdateRelaunching' | 'onUpdateRelaunchFailed'>,
): () => void {
  const offs = [
    bridge.onUpdateRelaunching(() => setInFlight(true)),
    bridge.onUpdateRelaunchFailed(() => setInFlight(false)),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/**
 * Install the module-init-time bridge subscription. Idempotent — a second call
 * is a no-op so HMR re-evaluation doesn't stack subscribers. Runs in the
 * renderer at `main.tsx`'s module-load side effect, before React mounts.
 */
export function installRelaunchStateBridge(): void {
  if (attached) return;
  if (typeof window === 'undefined') return;
  const bridge = window.okDesktop;
  if (!bridge) return;
  attached = true;
  attachRelaunchStateSubscribers(bridge);
}

/**
 * React hook reading the relaunch-in-flight flag. `useSyncExternalStore` is the
 * canonical path for a module-level external store; the server snapshot is
 * always `false` (SSR / non-desktop never has a relaunch underway).
 */
export function useRelaunchInFlight(): boolean {
  return useSyncExternalStore(subscribeRelaunchInFlight, getRelaunchInFlightSnapshot, () => false);
}

/**
 * Test-only reset for the module singleton. The store is a process-wide
 * singleton (`relaunchInFlight` / `attached` / `listeners`), so a test that
 * leaves the flag set or the bridge attached would silently taint a later test
 * importing this non-isolated module. Tests call this in teardown.
 */
export function resetRelaunchStoreForTest(): void {
  relaunchInFlight = false;
  attached = false;
  listeners.clear();
}
