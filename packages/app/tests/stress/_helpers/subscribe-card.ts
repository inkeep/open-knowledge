import type { Page } from '@playwright/test';

export const NEWSLETTER_KEY = 'ok-subscribe-card-v1';

export interface NewsletterState {
  readonly subscribed: boolean;
  readonly dismissed: boolean;
  readonly shownVersions: readonly string[];
}

export const NEWSLETTER_USED_UP: NewsletterState = {
  subscribed: true,
  dismissed: false,
  shownVersions: [],
};

export async function seedNewsletterStateBeforeLoad(
  page: Page,
  state: NewsletterState,
): Promise<void> {
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: NEWSLETTER_KEY,
    value: JSON.stringify(state),
  });
}
