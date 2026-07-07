/**
 * Onboarding step-completion recorders. Both are gated so they only ever
 * record progress for an *active* onboarding session — a successful AI dispatch
 * or a file created by an established user (one who never saw the card) is not
 * onboarding progress and must not write onboarding state.
 *
 * Kept out of the card component so the signals fire from their real sources
 * (the file signal from the document-change bus while the card is mounted; the
 * Ask-AI signal from the composer's dispatch path) rather than depending on
 * where the card happens to render.
 */

import { type OnboardingCardStore, onboardingCardStore } from '@/lib/onboarding-card-store';
import { fetchDocumentEntryCount } from '@/lib/onboarding-document-count';

/**
 * Mark the "create your first file" step complete once the project has at least
 * one content entry. No-op if onboarding isn't active, the step is already done,
 * or the count read fails (the next document-change event retries). The
 * `initialized` gate mirrors the Ask-AI recorder so a file created by an
 * established user never writes onboarding state, regardless of call site. The
 * `store` parameter is a test seam.
 */
export async function recordOnboardingFileStep(
  store: OnboardingCardStore = onboardingCardStore,
): Promise<void> {
  const snapshot = store.getSnapshot();
  if (snapshot.steps.file || !snapshot.initialized) return;
  try {
    if ((await fetchDocumentEntryCount()) >= 1) store.markStepComplete('file');
  } catch (err) {
    // Transient/failed count read — leave the step incomplete; a later
    // documents-changed event re-runs this.
    console.warn('[onboarding-signals] file-step count read failed; leaving step incomplete', err);
  }
}

/**
 * Mark the "Ask AI" step complete after a question is successfully dispatched.
 * Gated on `initialized` so a dispatch by an established user (no active card)
 * does not write onboarding state. The `store` parameter is a test seam.
 */
export function recordOnboardingAskedAi(store: OnboardingCardStore = onboardingCardStore): void {
  if (store.getSnapshot().initialized) store.markStepComplete('askedAi');
}
