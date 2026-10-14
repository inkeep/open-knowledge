import type { Page } from '@playwright/test';

export const PROSEMIRROR_FOCUS_SYNC_DELAY_MS = 20;

export async function afterEditorFocusSync(page: Page): Promise<void> {
  await page.evaluate(
    (delayMs) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }),
    PROSEMIRROR_FOCUS_SYNC_DELAY_MS,
  );
}
