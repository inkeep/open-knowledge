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
