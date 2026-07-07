/**
 * Drives the "create your first file" onboarding step. Mounted by the
 * onboarding card (so it only runs while the card is active), it watches the
 * document-change bus and marks the step complete once the project has content.
 * An initial check at mount catches a file created between activation and mount.
 */

import { useEffect } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import { type OnboardingCardStore, onboardingCardStore } from '@/lib/onboarding-card-store';
import { recordOnboardingFileStep } from '@/lib/onboarding-signals';

export function useOnboardingFileCompletion(
  store: OnboardingCardStore = onboardingCardStore,
): void {
  useEffect(() => {
    if (store.getSnapshot().steps.file) return;
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files')) void recordOnboardingFileStep(store);
    });
    void recordOnboardingFileStep(store);
    return unsubscribe;
  }, [store]);
}
