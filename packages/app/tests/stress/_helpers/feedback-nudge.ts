import type { Page } from '@playwright/test';
import type { FeedbackNudgeState } from '@/lib/feedback-nudge-store';

export const FEEDBACK_NUDGE_KEY = 'ok-feedback-nudge-v1';

const FEEDBACK_NUDGE_DOC_COUNT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

function eligibleFeedbackNudgeState(now = Date.now()): FeedbackNudgeState {
  return { firstSeenAt: now - 15 * DAY_MS, shownAt: null, dismissed: false };
}

interface SeedDocsApi {
  seedDocs(docs: Array<{ name: string; markdown: string }>): Promise<void>;
}

export async function seedFeedbackEligibleDocs(api: SeedDocsApi, prefix: string): Promise<string> {
  const docNameAt = (index: number) => `${prefix}-${index + 1}`;
  await api.seedDocs(
    Array.from({ length: FEEDBACK_NUDGE_DOC_COUNT }, (_, index) => {
      const name = docNameAt(index);
      return {
        name,
        markdown: `---\ntitle: "${name}"\n---\n\n# ${name}\n\nSeeded so the feedback card counts ten documents.\n`,
      };
    }),
  );
  return docNameAt(0);
}

export async function seedFeedbackNudgeStateBeforeLoad(
  page: Page,
  state: FeedbackNudgeState = eligibleFeedbackNudgeState(),
): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    { key: FEEDBACK_NUDGE_KEY, value: JSON.stringify(state) },
  );
}
