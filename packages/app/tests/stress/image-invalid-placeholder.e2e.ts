/**
 * Real-browser coverage for the truthful invalid-image placeholder
 * (LoadingImage + the target-existence oracle). jsdom can drive the state
 * machine but cannot load bytes, decode, cache, or run the watcher → oracle
 * push; this exercises all of those against real Chromium + a real asset
 * server:
 *
 *   - a proven-absent target renders "Image not found" (markdown + HTML forms)
 *     without rewriting the authored source bytes;
 *   - an existing target whose bytes can't decode renders "Image couldn't be
 *     displayed", never claiming absence;
 *   - a page reload keeps the undecodable placeholder (cached-failure path:
 *     the <img> is `complete` at mount, so decode() is the only signal);
 *   - creating the target on disk heals "Image not found" to a loaded image
 *     without a reload (watcher → CC1 files push → oracle flip → remount).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '_fixtures');

async function getSourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

async function openDocWithBody(
  page: Page,
  api: { createPage(p: string): Promise<void>; replaceDoc(d: string, md: string): Promise<void> },
  body: string,
  docName = `img-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, body);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  return docName;
}

test.describe('invalid-image placeholder (PRD-7860)', () => {
  test('a proven-missing markdown image renders "Image not found" and does not rewrite the source', async ({
    page,
    api,
  }) => {
    const missing = `/no-such-${randomUUID().slice(0, 8)}.png`;
    const body = `# Missing\n\n![a missing photo](${missing})\n`;
    await openDocWithBody(page, api, body);

    // The oracle settles to "missing" once /api/documents (which omits the
    // absent file) has loaded; a proven-absent target is authoritative.
    await expect(page.getByRole('img', { name: /Image not found/i })).toBeVisible({
      timeout: 15_000,
    });
    const slot = page.locator('[data-testid="image-slot"][data-image-error-kind="not-found"]');
    await expect(slot).toHaveCount(1);

    // Byte-sacred: the authored markdown is untouched by the placeholder.
    expect(await getSourceText(page)).toContain(`![a missing photo](${missing})`);
  });

  test('a proven-missing bare HTML <img> also renders "Image not found"', async ({ page, api }) => {
    const missing = `/no-html-${randomUUID().slice(0, 8)}.png`;
    const bareImage = `<img src="${missing}" alt="html photo">`;
    const body = `# Missing HTML\n\n${bareImage}\n`;
    await openDocWithBody(page, api, body);

    await expect(page.getByRole('img', { name: /Image not found/i })).toBeVisible({
      timeout: 15_000,
    });
    expect(await getSourceText(page)).toBe(body);
  });

  test('an existing image whose bytes cannot decode renders "Image couldn\'t be displayed"', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = `corrupt-${randomUUID().slice(0, 8)}.png`;
    // A real file exists (so the oracle reports it present), but the bytes are
    // not a decodable image → the browser fires `error` → undisplayable, never
    // "not found".
    writeFileSync(join(workerServer.contentDir, name), 'this is definitely not a PNG', 'utf-8');
    await openDocWithBody(page, api, `# Corrupt\n\n![corrupt](/${name})\n`);

    await expect(page.getByRole('img', { name: /couldn't be displayed/i })).toBeVisible({
      timeout: 15_000,
    });
    // It must not read as absent.
    await expect(page.locator('[data-image-error-kind="not-found"]')).toHaveCount(0);
  });

  test('error placeholders stay inside narrow table cells with readable text', async ({
    page,
    api,
    workerServer,
  }) => {
    const corrupt = `corrupt-table-${randomUUID().slice(0, 8)}.png`;
    const missing = `/missing-table-${randomUUID().slice(0, 8)}.png`;
    writeFileSync(join(workerServer.contentDir, corrupt), 'not a PNG', 'utf-8');
    await openDocWithBody(
      page,
      api,
      [
        '| State | Example | Probe | Expected behavior | Why | Comments |',
        '| --- | --- | --- | --- | --- | --- |',
        `| Broken | ![missing table image](${missing}) | Missing image | Show an error without covering this text. | Target is absent. | Persistent state. |`,
        `| Display failure | ![corrupt table image](/${corrupt}) | Existing invalid image | Show a warning without covering this text. | Bytes cannot decode. | Persistent state. |`,
        '',
      ].join('\n'),
    );

    const placeholders = page.locator('.ok-image-error-placeholder');
    await expect(placeholders).toHaveCount(2, { timeout: 15_000 });

    for (const placeholder of await placeholders.all()) {
      const geometry = await placeholder.evaluate((element) => {
        const cell = element.closest('td');
        if (!cell) return null;
        const elementRect = element.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();
        return {
          elementRight: elementRect.right,
          cellRight: cellRect.right,
          elementLeft: elementRect.left,
          cellLeft: cellRect.left,
        };
      });
      expect(geometry).not.toBeNull();
      expect(geometry?.elementLeft).toBeGreaterThanOrEqual((geometry?.cellLeft ?? 0) - 0.5);
      expect(geometry?.elementRight).toBeLessThanOrEqual((geometry?.cellRight ?? 0) + 0.5);

      const textStyles = await placeholder.evaluate((element) => {
        const message = element.querySelector('.ok-image-error-message');
        const target = element.querySelector('.ok-image-error-target');
        const rootStyle = getComputedStyle(document.documentElement);
        return {
          messageColor: message ? getComputedStyle(message).color : null,
          targetColor: target ? getComputedStyle(target).color : null,
          targetOpacity: target ? getComputedStyle(target).opacity : null,
          foreground: rootStyle.getPropertyValue('--foreground').trim(),
        };
      });
      expect(textStyles.messageColor).toBe(textStyles.foreground);
      expect(textStyles.targetColor).toBe(textStyles.foreground);
      expect(textStyles.targetOpacity).toBe('1');
    }
  });

  test('all stable authored image forms share the same valid, missing, and undecodable states', async ({
    page,
    api,
    workerServer,
  }) => {
    const runId = randomUUID().slice(0, 8);
    const folder = `image-forms-${runId}`;
    const docName = `${folder}/matrix`;
    const assetDir = join(workerServer.contentDir, folder, 'assets');
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(join(assetDir, 'valid.png'), readFileSync(join(FIXTURES_DIR, 'real-shot.png')));
    writeFileSync(join(assetDir, 'corrupt.png'), 'not a PNG', 'utf-8');

    const body = [
      '# Image forms',
      '',
      '## Markdown',
      '![Markdown valid](assets/valid.png)',
      '![Markdown missing](assets/missing.png)',
      '![Markdown corrupt](assets/corrupt.png)',
      '',
      '## Bare HTML',
      '<img src="assets/valid.png" alt="Bare HTML valid">',
      '<img src="assets/missing.png" alt="Bare HTML missing">',
      '<img src="assets/corrupt.png" alt="Bare HTML corrupt">',
      '',
      '## JSX-style HTML',
      '<img src="assets/valid.png" alt="JSX valid" />',
      '<img src="assets/missing.png" alt="JSX missing" />',
      '<img src="assets/corrupt.png" alt="JSX corrupt" />',
      '',
      '## Reference style',
      '![Reference valid][image-valid]',
      '![Reference missing][image-missing]',
      '![Reference corrupt][image-corrupt]',
      '',
      '[image-valid]: assets/valid.png',
      '[image-missing]: assets/missing.png',
      '[image-corrupt]: assets/corrupt.png',
      '',
    ].join('\n');
    await openDocWithBody(page, api, body, docName);

    const forms = ['Markdown', 'Bare HTML', 'JSX', 'Reference'];
    for (const form of forms) {
      const valid = page.getByRole('img', { name: `${form} valid`, exact: true });
      await valid.scrollIntoViewIfNeeded();
      await expect(valid).toBeVisible({ timeout: 15_000 });

      const missing = page.getByRole('img', {
        name: `Image not found: ${form} missing`,
        exact: true,
      });
      await missing.scrollIntoViewIfNeeded();
      await expect(missing).toBeVisible({ timeout: 15_000 });

      const corrupt = page.getByRole('img', {
        name: `Image couldn't be displayed: ${form} corrupt`,
        exact: true,
      });
      await corrupt.scrollIntoViewIfNeeded();
      await expect(corrupt).toBeVisible({ timeout: 15_000 });
    }

    await expect(page.locator('[data-image-error-kind="not-found"]')).toHaveCount(4);
    await expect(page.locator('[data-image-error-kind="undisplayable"]')).toHaveCount(4);
    await expect(
      page.locator(
        `[data-image-reference-view] img[alt="Reference valid"][src$="/${folder}/assets/valid.png"]`,
      ),
    ).toBeVisible();
    expect((await getSourceText(page)).trimEnd()).toBe(body.trimEnd());
  });

  test('reloading keeps the undecodable placeholder (cached-failure decode path)', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = `cached-${randomUUID().slice(0, 8)}.png`;
    writeFileSync(join(workerServer.contentDir, name), 'still not a PNG', 'utf-8');
    const docName = await openDocWithBody(page, api, `# Cached\n\n![cached](/${name})\n`);
    await expect(page.getByRole('img', { name: /couldn't be displayed/i })).toBeVisible({
      timeout: 15_000,
    });

    // On reload the <img> is `complete` at first mount and `error` will not
    // re-fire; decode() must reclassify the cached failure.
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await expect(page.getByRole('img', { name: /couldn't be displayed/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('creating the target on disk heals "Image not found" to a loaded image without reload', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = `created-${randomUUID().slice(0, 8)}.png`;
    await openDocWithBody(page, api, `# Heal\n\n![created](/${name})\n`);

    await expect(page.getByRole('img', { name: /Image not found/i })).toBeVisible({
      timeout: 15_000,
    });

    // Land real, decodable PNG bytes at the target path. The watcher indexes
    // it → CC1 `files` push → page-list refetch → oracle flips exists →
    // LoadingImage remounts and re-requests the now-present bytes.
    const png = readFileSync(join(FIXTURES_DIR, 'real-shot.png'));
    writeFileSync(join(workerServer.contentDir, name), png);

    // Placeholder clears without a reload and the real <img> loads.
    await expect(page.getByRole('img', { name: /Image not found/i })).toHaveCount(0, {
      timeout: 25_000,
    });
    await expect(page.locator('[data-testid="image-slot"][data-image-error]')).toHaveCount(0);
    const img = page.locator(`.ProseMirror:not(.composer-prosemirror) img[src$="/${name}"]`);
    await expect(img).toBeVisible({ timeout: 25_000 });
  });
});
