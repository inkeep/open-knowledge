import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

async function yieldFramesInPage(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as typeof window & { __okYieldFrameCount?: number };
      w.__okYieldFrameCount = (w.__okYieldFrameCount ?? 0) + 1;
      if (w.__okYieldFrameCount >= 3) {
        w.__okYieldFrameCount = 0;
        return true;
      }
      return false;
    },
    null,
    { polling: 'raf', timeout: 10_000 },
  );
}

const CM6_BODY = [
  '# CM6 Elements (Long Doc — cross-doc bleed RED test)',
  '',
  'This is a long document used to demonstrate cross-doc bleed.',
  'The CANARY token below is the empirical signal that CM6 content is',
  'leaking into the new file Activity.',
  '',
  'CANARY_CROSS_DOC_BLEED_TOKEN_XYZ_123456789ABCDEF',
  '',
  '## Section A',
  'Line 1 in section A. Line 2 in section A. Line 3 in section A.',
  '',
  '## Section B',
  'Line 1 in section B. Line 2 in section B.',
  '',
  '## Section C',
  'Line 1 in section C. Line 2 in section C.',
].join('\n');

const CANARY = 'CANARY_CROSS_DOC_BLEED_TOKEN_XYZ_123456789ABCDEF';

async function newFileViaShortcut(page: Page, newDocName: string): Promise<void> {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.waitForFunction(
    () => document.activeElement === null || document.activeElement === document.body,
    null,
    { timeout: 1_000 },
  );

  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modKey}+Alt+KeyN`);

  await expect(page.getByRole('dialog', { name: /New file/i })).toBeVisible({
    timeout: 5_000,
  });

  await page.getByLabel(/^File name$/i).fill(newDocName);
  await page.getByRole('button', { name: /^Create$/ }).click();

  await expect(page.getByRole('dialog', { name: /New file/i })).toBeHidden({
    timeout: 5_000,
  });

  await page.waitForFunction((expected) => window.location.hash.includes(expected), newDocName, {
    timeout: 10_000,
  });

  await waitForActiveProviderSynced(page);
  await yieldFramesInPage(page);
  await yieldFramesInPage(page);
}

async function deleteFileViaApi(baseURL: string, path: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'file', path }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete-path failed for ${path}: ${res.status}`);
  }
}

function visibleScrollContainer(page: Page): Locator {
  return page.locator('[data-testid="editor-scroll-container"]:visible');
}

async function assertVisibleActivityHasOnlyEmptyEditor(page: Page): Promise<void> {
  const scroll = visibleScrollContainer(page);
  await expect(
    scroll,
    'exactly one editor scroll container should be visible after the New File flow',
  ).toHaveCount(1);

  const pms = scroll.locator('.tiptap.ProseMirror');
  await expect(
    pms,
    "new file Activity must contain exactly one .tiptap.ProseMirror (cross-doc bleed signal: pmCount > 1 means another editor's view.dom has been vacuumed into this Activity's EditorContent ref div)",
  ).toHaveCount(1);

  await expect(
    pms.first(),
    "the new file's editor must render empty placeholder content (cross-doc bleed signal: non-empty textContent means the orphaned PM is from a different doc)",
  ).toHaveText('');
}

test.describe('new-file cross-doc bleed', () => {
  test('open doc then New File: new file Activity must contain exactly one empty editor', async ({
    page,
    api,
  }) => {
    test.setTimeout(60_000);

    const seedDocName = `seed-${randomUUID()}`;
    await api.seedDocs([{ name: seedDocName, markdown: CM6_BODY }]);

    await page.goto(`/#/${seedDocName}`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText(CANARY)).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    await expect(visibleScrollContainer(page).locator('.tiptap.ProseMirror')).toHaveCount(1);

    const newDocName = `newfile-${randomUUID()}`;
    await newFileViaShortcut(page, newDocName);

    await assertVisibleActivityHasOnlyEmptyEditor(page);
  });

  test('open A, navigate to B, then New File: new file Activity must contain exactly one empty editor', async ({
    page,
    api,
  }) => {
    test.setTimeout(60_000);

    const docA = `seed-a-${randomUUID()}`;
    const docB = `seed-b-${randomUUID()}`;
    await api.seedDocs([
      { name: docA, markdown: CM6_BODY },
      { name: docB, markdown: '# Doc B Heading\n\nDoc B body content.' },
    ]);

    await page.goto(`/#/${docA}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(CANARY)).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    await page.goto(`/#/${docB}`);
    await expect(page.getByText('Doc B body content.')).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    const newDocName = `newfile-${randomUUID()}`;
    await newFileViaShortcut(page, newDocName);

    await assertVisibleActivityHasOnlyEmptyEditor(page);
  });

  test('open A, delete A, then New File with the just-deleted docName: still exactly one empty editor', async ({
    page,
    api,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const reusedDocName = `reused-${randomUUID()}`;
    await api.seedDocs([{ name: reusedDocName, markdown: CM6_BODY }]);

    await page.goto(`/#/${reusedDocName}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(CANARY)).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    if (!baseURL) throw new Error('baseURL fixture missing');
    await deleteFileViaApi(baseURL, `${reusedDocName}.md`);
    await yieldFramesInPage(page);
    await yieldFramesInPage(page);

    await newFileViaShortcut(page, reusedDocName);

    await assertVisibleActivityHasOnlyEmptyEditor(page);
  });
});
