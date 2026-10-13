import { expect, test } from '@playwright/test';
import { ASSERTION_ELAPSED_ANNOTATION, MET_CASE, UNMET_CASE } from './cases.ts';

test.beforeEach(async ({ page }) => {
  await page.setContent('<p>present</p>');
});

test(MET_CASE, async ({ page }) => {
  await expect(page.getByText('present')).toBeVisible();
});

test(UNMET_CASE, async ({ page }) => {
  const started = performance.now();
  try {
    await expect(page.getByText('absent')).toBeVisible();
  } finally {
    test.info().annotations.push({
      type: ASSERTION_ELAPSED_ANNOTATION,
      description: String(Math.round(performance.now() - started)),
    });
  }
});
