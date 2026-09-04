import { useEffect, useSyncExternalStore } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { type OnboardingCardStore, onboardingCardStore } from '@/lib/onboarding-card-store';
import { fetchDocumentEntryCount } from '@/lib/onboarding-document-count';

export async function evaluateFreshProject(bridge: OkDesktopBridge): Promise<number | null> {
  try {
    const recents = await bridge.project.listRecent();
    const currentPath = bridge.config.projectPath;
    const hasOtherProject = recents.some((entry) => entry.path !== currentPath);
    if (hasOtherProject) return null;
    const entryCount = await fetchDocumentEntryCount();
    if (bridge.config.freshlyCreated) return entryCount;
    return entryCount === 0 ? 0 : null;
  } catch (err) {
    console.warn('[onboarding-card-visible] fresh-project probe failed; suppressing card', err);
    return null;
  }
}

export function useOnboardingCardVisible(
  store: OnboardingCardStore = onboardingCardStore,
): boolean {
  const { initialized, dismissed, completed } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const suppressed = dismissed || completed;
  const shouldEvaluate = !initialized && !suppressed;

  useEffect(() => {
    if (!shouldEvaluate) return;
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
