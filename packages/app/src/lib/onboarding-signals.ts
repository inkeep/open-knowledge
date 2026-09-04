import { type OnboardingCardStore, onboardingCardStore } from '@/lib/onboarding-card-store';
import { fetchDocumentEntryCount } from '@/lib/onboarding-document-count';

export async function recordOnboardingFileStep(
  store: OnboardingCardStore = onboardingCardStore,
): Promise<void> {
  const snapshot = store.getSnapshot();
  if (snapshot.steps.file || !snapshot.initialized) return;
  try {
    if ((await fetchDocumentEntryCount()) > snapshot.fileBaseline) store.markStepComplete('file');
  } catch (err) {
    console.warn('[onboarding-signals] file-step count read failed; leaving step incomplete', err);
  }
}

export function recordOnboardingAskedAi(store: OnboardingCardStore = onboardingCardStore): void {
  if (store.getSnapshot().initialized) store.markStepComplete('askedAi');
}
