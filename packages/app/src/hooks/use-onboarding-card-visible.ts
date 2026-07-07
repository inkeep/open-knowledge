/**
 * Visibility predicate for the first-run onboarding card.
 *
 * The card is for genuinely new desktop users only. `useOnboardingCardVisible`
 * decides whether it renders by combining three gates:
 *   1. Host gate — only the Electron host exposes `window.okDesktop`; web / CLI
 *      builds render nothing because the predicate is never evaluated there.
 *   2. Fresh-project gate — the user has no other projects (`listRecent`
 *      filtered to other switchable projects is empty) AND this project is
 *      empty (entry count 0 at first sight).
 *   3. Store-flag gate — a card that was dismissed or completed on this device
 *      never returns.
 *
 * Activation latches. Once the fresh-project gate passes we call
 * `store.activate()`, which persists `initialized`. From then on visibility is
 * derived purely from the store, so creating the first file (which bumps the
 * entry count past 0) does not flip the card off mid-onboarding — only dismiss
 * or completion does.
 *
 * `evaluateFreshProject` is split out and exported so the fail-safe is testable
 * directly: it is guaranteed to *resolve* (never reject), turning any failure
 * to confirm new-user status — an IPC rejection from the desktop bridge or a
 * failed / malformed `/api/documents` response — into a suppressed card rather
 * than one shown to a user we could not confirm is new. Both reads cross a
 * process / network seam, so the single catch sits at a real trust boundary.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { type OnboardingCardStore, onboardingCardStore } from '@/lib/onboarding-card-store';
import { fetchDocumentEntryCount } from '@/lib/onboarding-document-count';

/**
 * Resolve whether this is a fresh, single-project desktop session: no other
 * switchable projects and zero content entries. Resolves `false` on any failure
 * to confirm that status — the card stays hidden rather than showing blind.
 */
export async function evaluateFreshProject(bridge: OkDesktopBridge): Promise<boolean> {
  try {
    const recents = await bridge.project.listRecent();
    const currentPath = bridge.config.projectPath;
    const hasOtherProject = recents.some((entry) => entry.path !== currentPath);
    if (hasOtherProject) return false;
    return (await fetchDocumentEntryCount()) === 0;
  } catch (err) {
    // listRecent (IPC) or /api/documents (network) failed — we cannot confirm
    // a new user, so suppress rather than ambush an established one.
    console.warn('[onboarding-card-visible] fresh-project probe failed; suppressing card', err);
    return false;
  }
}

/**
 * The `store` parameter is an injection seam for tests (pass a fresh
 * `createOnboardingCardStore(...)` instance for isolated state); production
 * callers use the singleton default.
 */
export function useOnboardingCardVisible(
  store: OnboardingCardStore = onboardingCardStore,
): boolean {
  const { initialized, dismissed, completed } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const suppressed = dismissed || completed;
  // Only the not-yet-latched, not-yet-suppressed state needs the async probe;
  // once `initialized` flips true the card rides the store flags alone (latch).
  const shouldEvaluate = !initialized && !suppressed;

  useEffect(() => {
    if (!shouldEvaluate) return;
    // useEffect only runs client-side, so `window` is always defined here.
    const bridge = window.okDesktop;
    if (bridge == null) return;
    let cancelled = false;
    void evaluateFreshProject(bridge).then((isFresh) => {
      if (!cancelled && isFresh) store.activate();
    });
    return () => {
      cancelled = true;
    };
  }, [shouldEvaluate, store]);

  return initialized && !suppressed;
}
