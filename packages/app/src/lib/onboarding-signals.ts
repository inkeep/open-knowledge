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
 * Mark the "create your first file" step complete once the project's entry count
 * rises ABOVE the baseline captured at activation (`snapshot.fileBaseline`). For
 * a blank project the baseline is 0, so any first file completes it (`> 0` ≡ the
 * old `>= 1`); for a starter-pack project the baseline is the seeded template
 * count, so the step completes only when the user authors a doc beyond the seed —
 * a pack's templates never auto-complete a step the user hasn't performed. No-op
 * if onboarding isn't active, the step is already done, or the count read fails
 * (the next document-change event retries). The `initialized` gate mirrors the
 * Ask-AI recorder so a file created by an established user never writes onboarding
 * state, regardless of call site. The `store` parameter is a test seam.
 */
export async function recordOnboardingFileStep(
  store: OnboardingCardStore = onboardingCardStore,
): Promise<void> {
  const snapshot = store.getSnapshot();
  if (snapshot.steps.file || !snapshot.initialized) return;
  try {
    if ((await fetchDocumentEntryCount()) > snapshot.fileBaseline) store.markStepComplete('file');
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
