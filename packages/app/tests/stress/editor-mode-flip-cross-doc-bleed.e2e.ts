import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

async function yieldFramesInPage(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

const SEED_A_BODY = [
  '# Seed A (substantial content — mode-flip cross-doc bleed canary)',
  '',
  'This is the warm "long" doc; it stays in the Activity pool',
  'while Seed B (empty) is the active doc. If mode-flip causes any',
  'cross-Activity DOM transfer, Seed A content will leak into Seed B.',
  '',
  'CANARY_MODE_FLIP_BLEED_TOKEN_ABC_987654321FEDCBA',
  '',
  '## Section A',
  'Line 1 of section A. Line 2 of section A. Line 3 of section A.',
  '',
  '## Section B',
  'Line 1 of section B. Line 2 of section B.',
  '',
  '## Section C',
  'Line 1 of section C. Line 2 of section C. Line 3 of section C.',
].join('\n');

const CANARY = 'CANARY_MODE_FLIP_BLEED_TOKEN_ABC_987654321FEDCBA';

function visibleScrollContainer(page: Page): Locator {
  return page.locator('[data-testid="editor-scroll-container"]:visible');
}

async function assertVisibleActivityHasOnlyEmptyEditor(page: Page): Promise<void> {
  const scroll = visibleScrollContainer(page);
  await expect(
    scroll,
    'exactly one editor scroll container should be visible after the mode-flip flow',
  ).toHaveCount(1);

  const pms = scroll.locator('.tiptap.ProseMirror');
  await expect(
    pms,
    "empty-doc Activity must contain exactly one .tiptap.ProseMirror (cross-doc bleed signal: pmCount > 1 means another editor's view.dom has been vacuumed into this Activity's EditorContent ref div)",
  ).toHaveCount(1);

  await expect(
    pms.first(),
    "empty doc's editor must render empty placeholder content (cross-doc bleed signal: non-empty textContent means the orphaned PM is from a different doc)",
  ).toHaveText('');
}

test.describe('editor mode-flip cross-doc bleed', () => {
  test('open A, navigate to B (empty), source toggle, visual toggle: B Activity must contain exactly one empty editor', async ({
    page,
    api,
  }) => {
    test.setTimeout(60_000);

    const seedAName = `seed-a-${randomUUID()}`;
    const seedBName = `seed-b-${randomUUID()}`;
    await api.seedDocs([{ name: seedAName, markdown: SEED_A_BODY }]);
    await api.createPage(`${seedBName}.md`);

    await page.goto(`/#/${seedAName}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(CANARY)).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    await expect(visibleScrollContainer(page).locator('.tiptap.ProseMirror')).toHaveCount(1);

    await page.goto(`/#/${seedBName}`);
    await page.waitForFunction(
      (expected) => window.__providerPool?.getActiveDocName?.() === expected,
      seedBName,
      { timeout: 10_000 },
    );
    await waitForActiveProviderSynced(page);
    await yieldFramesInPage(page);
    await yieldFramesInPage(page);

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.waitForFunction(
      () => document.activeElement === null || document.activeElement === document.body,
      null,
      { timeout: 1_000 },
    );

    const sourceToggle = page.getByRole('radio', { name: 'Markdown source' });
    await sourceToggle.click();
    await expect(page.locator('.cm-editor').first()).toBeVisible({ timeout: 10_000 });
    await yieldFramesInPage(page);
    await yieldFramesInPage(page);

    const visualToggle = page.getByRole('radio', { name: 'Visual editor' });
    await visualToggle.click();
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 10_000 });
    await yieldFramesInPage(page);
    await yieldFramesInPage(page);

    await assertVisibleActivityHasOnlyEmptyEditor(page);
  });
});
