/**
 * Visibility predicate for the first-run onboarding card.
 *
 * The card is for genuinely new desktop users only. `useOnboardingCardVisible`
 * decides whether it renders by combining three gates:
 *   1. Host gate — only the Electron host exposes `window.okDesktop`; web / CLI
 *      builds render nothing because the predicate is never evaluated there.
 *   2. Fresh-project gate — the user has no other projects (`listRecent`
 *      filtered to other switchable projects is empty) AND either this window
 *      was opened by a first-run create-new flow (`config.freshlyCreated`, true
 *      for both blank and starter-pack-seeded projects) OR the project is empty
 *      (entry count 0 at first sight). The create-new short-circuit exists
 *      because a starter pack scaffolds content at create time, which would
 *      otherwise fail the entry-count check; opening a pre-existing populated
 *      folder is not create-new, so it stays suppressed — the deliberate
 *      protection for an established single-project user opening their vault.
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
 * Resolve whether this is a fresh, single-project desktop session and, if so,
 * the file-step baseline to latch with. Returns the entry count at activation
 * (the "create your first file" baseline) when the card should activate, or
 * `null` when it should not — no other switchable projects, and either a
 * first-run create-new open or a genuinely empty project. Returns `null` on any
 * failure to confirm that status — the card stays hidden rather than showing
 * blind.
 */
export async function evaluateFreshProject(bridge: OkDesktopBridge): Promise<number | null> {
  try {
    const recents = await bridge.project.listRecent();
    const currentPath = bridge.config.projectPath;
    const hasOtherProject = recents.some((entry) => entry.path !== currentPath);
    if (hasOtherProject) return null;
    const entryCount = await fetchDocumentEntryCount();
    // A first-run create-new open (blank OR starter-pack seed) is a genuinely
    // new user regardless of content: a starter pack scaffolds files/folders at
    // create time, so the `entryCount === 0` gate below would misclassify a
    // seeded project as established and hide the card. `freshlyCreated` only
    // rides the `create-new` entry point, so opening a pre-existing populated
    // folder (pick-existing / recents) still falls through to the entry-count
    // gate and stays suppressed — the deliberate protection for an established
    // single-project user opening their existing vault. The count doubles as the
    // file-step baseline so the seed's own templates don't auto-complete "create
    // your first file".
    if (bridge.config.freshlyCreated) return entryCount;
    return entryCount === 0 ? 0 : null;
  } catch (err) {
    // listRecent (IPC) or /api/documents (network) failed — we cannot confirm
    // a new user, so suppress rather than ambush an established one.
    console.warn('[onboarding-card-visible] fresh-project probe failed; suppressing card', err);
    return null;
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
    void evaluateFreshProject(bridge).then((baseline) => {
      if (!cancelled && baseline !== null) store.activate(baseline);
    });
    return () => {
      cancelled = true;
    };
  }, [shouldEvaluate, store]);

  return initialized && !suppressed;
}
