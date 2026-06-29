import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

const STORAGE_KEY = 'ok-editor-mode-v1';

async function expectSourceMounted(page: Page, timeout = 10_000): Promise<void> {
  await expect(page.locator('.cm-editor').first()).toBeVisible({ timeout });
}

async function expectWysiwygMounted(page: Page, timeout = 10_000): Promise<void> {
  await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout });
}

test.describe('editor-mode-persistence — SPEC §8.3', () => {
  test('T1: refresh preserves persisted mode', async ({ page, api }) => {
    const docName = `test-emp-t1-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);

    await sourceToggle(page).click();
    await expectSourceMounted(page);

    const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(stored).toBe('source');

    await page.reload();
    await waitForProvider(page);

    await expectSourceMounted(page);
    const postReloadGlobal = await page.evaluate(
      () => (window as unknown as { __OK_EDITOR_MODE__?: unknown }).__OK_EDITOR_MODE__,
    );
    expect(postReloadGlobal).toBe('source');
  });

  test('T2: new tab inherits persisted mode', async ({ context, page, api }) => {
    const docName = `test-emp-t2-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);
    await sourceToggle(page).click();
    await expectSourceMounted(page);

    const pageB = await context.newPage();
    await pageB.goto(`/#/${docName}`);
    await waitForProvider(pageB);

    await expectSourceMounted(pageB);
  });

  test('T3: open tabs are independent until reload', async ({ context, page, api }) => {
    const docName = `test-emp-t3-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);

    const pageB = await context.newPage();
    await pageB.goto(`/#/${docName}`);
    await waitForProvider(pageB);
    await expectWysiwygMounted(pageB);

    await page.bringToFront();
    await sourceToggle(page).click();
    await expectSourceMounted(page);

    await pageB.bringToFront();
    await pageB.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await expectWysiwygMounted(pageB);
    await expect(pageB.locator('.cm-editor').first()).toBeHidden({ timeout: 2_000 });

    await pageB.reload();
    await waitForProvider(pageB);
    await expectSourceMounted(pageB);
  });

  test('T4: new doc honors persisted mode', async ({ page, api }) => {
    const seedDocName = `test-emp-t4a-${randomUUID().slice(0, 8)}`;
    const newDocName = `test-emp-t4b-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${seedDocName}.md`);
    await page.goto(`/#/${seedDocName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);

    await sourceToggle(page).click();
    await expectSourceMounted(page);

    await api.createPage(`${newDocName}.md`);
    await page.goto(`/#/${newDocName}`);
    await waitForProvider(page);

    await expectSourceMounted(page);
  });

  test('T6: invalid localStorage value falls back to default', async ({ context, page, api }) => {
    const docName = `test-emp-t6-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    await context.addInitScript((key) => {
      try {
        localStorage.setItem(key, 'garbage-from-manual-tampering-or-old-schema');
      } catch {}
    }, STORAGE_KEY);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);

    await expectWysiwygMounted(page);
    const globalAfterLoad = await page.evaluate(
      () => (window as unknown as { __OK_EDITOR_MODE__?: unknown }).__OK_EDITOR_MODE__,
    );
    expect(globalAfterLoad).toBe('wysiwyg');
  });

  test('T9: RAW_MDX_NAV_EVENT flips source mode WITHOUT persisting (FR-6 / §7.5)', async ({
    page,
    api,
  }) => {
    const docName = `test-emp-t9-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);

    const preFlipStored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(preFlipStored).toBe(null);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('raw-mdx-nav', { detail: { offset: 0 } }));
    });

    await expectSourceMounted(page);

    const postFlipStored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(postFlipStored).toBe(null);

    await page.reload();
    await waitForProvider(page);
    await expectWysiwygMounted(page);
  });

  test('T8: FOUC-free first paint when persisted=source', async ({ context, page, api }) => {
    const docName = `test-emp-t8-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    await context.addInitScript((key) => {
      try {
        localStorage.setItem(key, 'source');
      } catch {}
    }, STORAGE_KEY);

    await page.goto(`/#/${docName}`);

    const globalBeforeEditor = await page.evaluate(
      () => (window as unknown as { __OK_EDITOR_MODE__?: unknown }).__OK_EDITOR_MODE__,
    );
    expect(globalBeforeEditor).toBe('source');

    await waitForProvider(page);

    await expectSourceMounted(page);
    await expect(page.locator('.ProseMirror').first()).toBeHidden({ timeout: 2_000 });
  });
});
