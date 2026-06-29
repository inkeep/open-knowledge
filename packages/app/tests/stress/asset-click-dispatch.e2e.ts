
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  createPngBuffer,
  expect,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

async function getSourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

async function dropFileIntoEditor(
  page: Page,
  bytes: number[],
  filename: string,
  mime: string,
): Promise<void> {
  await page.evaluate(
    ({ bytes: byteArr, filename: fn, mime: mt }) => {
      const active = (window as unknown as { __activeEditor?: { view?: { dom?: HTMLElement } } })
        .__activeEditor;
      const editor = active?.view?.dom ?? null;
      if (!editor) throw new Error('no active editor (window.__activeEditor.view.dom)');
      const file = new File([new Uint8Array(byteArr)], fn, { type: mt });
      const dt = new DataTransfer();
      dt.items.add(file);
      const rect = editor.getBoundingClientRect();
      const cx = rect.left + Math.floor(rect.width / 2);
      const cy = rect.top + Math.floor(rect.height / 2);
      editor.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
        }),
      );
      editor.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
        }),
      );
    },
    { bytes, filename, mime },
  );
}

const TINY_PNG_BYTES = Array.from(createPngBuffer('asset-click-dispatch'));

const TINY_PDF_BYTES = Array.from(
  Buffer.from(
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj
xref
0 4
0000000000 65535 f
0000000010 00000 n
0000000050 00000 n
0000000090 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
140
%%EOF`,
    'utf-8',
  ),
);

test.describe('asset-click dispatcher — P9 E2E scenarios (SPEC 2026-04-23)', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `asset-dispatch-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, '# Dispatch test\n');
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('P9.1: post-reload `![[file.pdf]]` renders as a File row via WikiEmbedFile (no link chip)', async ({
    page,
    api,
  }) => {
    await api.replaceDoc(docName, `# Source\n\n![[meeting.pdf]]\n`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');

    const fileRow = page.locator('.ok-file-attachment').first();
    await fileRow.waitFor({ state: 'visible', timeout: 5_000 });

    const pdfChip = page.locator('span[data-link]').filter({ hasText: 'meeting.pdf' });
    await expect(pdfChip).toHaveCount(0);

    const pdfWrapper = page.locator('.ok-pdf');
    await expect(pdfWrapper).toHaveCount(0);
  });

  test('P9.9: [[foo]] wiki-link chip — bare click does NOT fire dispatcher (regression guard)', async ({
    page,
    api,
    context,
  }) => {
    const targetDoc = `foo-target-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${targetDoc}.md`);
    await api.replaceDoc(targetDoc, '# Target\n');
    await api.replaceDoc(docName, `# Source\n\n[[${targetDoc}]]\n`);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');

    const chip = page.locator('[data-wiki-link]').first();
    await chip.waitFor({ state: 'visible', timeout: 5_000 });
    await chip.click();

    const openedPage = await context.waitForEvent('page', { timeout: 1_000 }).catch(() => null);
    expect(openedPage).toBeNull();
  });

  test('P9.10: hand-authored [guide](./file.html) bare click → in-app asset preview (no new tab)', async ({
    page,
    api,
    context,
    workerServer,
  }) => {
    writeFileSync(
      join(workerServer.contentDir, 'guide.html'),
      '<!doctype html><meta charset="utf-8"><title>Guide</title><p>hi</p>',
    );

    await api.replaceDoc(docName, `# Markdown link test\n\nSee [the guide](./guide.html).\n`);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await expect(page.locator('[data-resolution-state="asset"]').first()).toBeVisible({
      timeout: 10_000,
    });

    await page.click('span[data-link]');

    await expect
      .poll(async () => page.evaluate(() => window.location.hash))
      .toBe('#/__asset__/guide.html');
    await expect(page.getByTestId('asset-preview-open-as-text')).toBeVisible({ timeout: 5_000 });

    const openedPage = await context.waitForEvent('page', { timeout: 1_000 }).catch(() => null);
    expect(openedPage).toBeNull();
  });

  test('P9.10b: Cmd/Ctrl+click on the same link is the OS-delegation escape hatch → new tab', async ({
    page,
    api,
    context,
    workerServer,
  }) => {
    writeFileSync(
      join(workerServer.contentDir, 'guide.html'),
      '<!doctype html><meta charset="utf-8"><title>Guide</title><p>hi</p>',
    );
    await api.replaceDoc(docName, `# Markdown link test\n\nSee [the guide](./guide.html).\n`);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await expect(page.locator('[data-resolution-state="asset"]').first()).toBeVisible({
      timeout: 10_000,
    });
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 5_000 }),
      page.click('span[data-link]', { modifiers: ['Meta'] }),
    ]);
    await newPage.waitForURL('**/guide.html', { timeout: 10_000 });
    await newPage.close();
  });

  test('P9.11: inline image click is a no-op (regression guard — dispatcher does not fire)', async ({
    page,
  }) => {
    await dropFileIntoEditor(page, TINY_PNG_BYTES, 'photo.png', 'image/png');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('photo.png');

    const img = page.locator('.ProseMirror img[src*="photo.png"]').first();
    await img.waitFor({ state: 'visible', timeout: 5_000 });

    await img.click();
    const openedPage = await page
      .context()
      .waitForEvent('page', { timeout: 1_000 })
      .catch(() => null);
    expect(openedPage).toBeNull();
  });

  test('P9.15: path-escape `../..` does NOT open a new tab (renderer refuses)', async ({
    page,
    api,
    context,
  }) => {
    await api.replaceDoc(
      docName,
      `# Escape attempt\n\n[evil](../../etc/config.pdf) should refuse.\n`,
    );
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');

    await page.click('span[data-link]');
    const openedPage = await context.waitForEvent('page', { timeout: 1_000 }).catch(() => null);
    expect(openedPage).toBeNull();
  });


  test('P9.17: subdirectory PNG drop — rendered <img> actually loads (naturalWidth > 0)', async ({
    page,
    api,
  }) => {
    const subdirDoc = `docs/sub-${randomUUID().slice(0, 6)}/notes`;
    await api.createPage(`${subdirDoc}.md`);
    await api.replaceDoc(subdirDoc, '# Subdir doc\n');
    await page.goto(`/#/${subdirDoc}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');

    await dropFileIntoEditor(page, TINY_PNG_BYTES, 'photo.png', 'image/png');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('photo.png');

    const img = page.locator('.ProseMirror img[src*="photo.png"]').first();
    await img.waitFor({ state: 'attached', timeout: 5_000 });

    await expect
      .poll(
        async () => {
          return await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
        },
        { timeout: 5_000, message: 'Subdir-doc PNG drop must render (bytes decoded)' },
      )
      .toBeGreaterThan(0);
  });

  test('P9.18: subdirectory PDF drop serves application/pdf inline through the serve middleware', async ({
    page,
    api,
  }) => {
    const subdirDoc = `docs/sub-${randomUUID().slice(0, 6)}/notes`;
    await api.createPage(`${subdirDoc}.md`);
    await api.replaceDoc(subdirDoc, '# Subdir doc\n');
    await page.goto(`/#/${subdirDoc}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');

    await dropFileIntoEditor(page, TINY_PDF_BYTES, 'doc.pdf', 'application/pdf');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('doc.pdf');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 30_000 })
      .toContain('![[doc.pdf]]');

    const expectedHref = `/${subdirDoc.split('/').slice(0, -1).join('/')}/doc.pdf`;

    const res = await page.request.get(expectedHref);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/^application\/pdf/);
    expect(res.headers()['content-disposition']).toBe('inline');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('P9.20: `.md` drop with case-preserved basename — chip resolves against existing doc', async ({
    page,
    api,
  }) => {
    test.skip(
      true,
      'CI-only flake (passes 3/3 locally, fails 3/3 in CI parallel workers since the 2026-05-18T13:46Z cap-blow window). Was 4.8s in last green; now 9.7s+ in CI suggests parallel-worker state pollution. See issue #1056.',
    );
    const existingBasename = `CaseCheck${randomUUID().slice(0, 6)}`;
    await api.createPage(`${existingBasename}.md`);
    await api.replaceDoc(existingBasename, '# Target doc\n');

    await dropFileIntoEditor(
      page,
      Array.from(Buffer.from(`# ${existingBasename}\n`, 'utf-8')),
      `${existingBasename}.md`,
      'text/markdown',
    );

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain(existingBasename);

    const chip = page.locator('[data-wiki-link]').first();
    await chip.waitFor({ state: 'visible', timeout: 5_000 });

    await chip.hover();

    await expect(page.getByText('Wiki link').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Page not found')).not.toBeVisible();
  });

  test('P9.21: `.m4v` drop renders through Video JSX + server serves video/mp4 inline (2026-04-24b)', async ({
    page,
    api,
  }) => {
    const subdirDoc = `docs/sub-${randomUUID().slice(0, 6)}/notes`;
    await api.createPage(`${subdirDoc}.md`);
    await api.replaceDoc(subdirDoc, '# Video doc\n');
    await page.goto(`/#/${subdirDoc}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');

    const TINY_M4V_BYTES = Array.from(
      Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4V '), Buffer.alloc(8, 0)]),
    );
    await dropFileIntoEditor(page, TINY_M4V_BYTES, 'clip.m4v', 'video/mp4');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('clip.m4v');
    const text = await getSourceText(page);
    expect(text).toMatch(/<video\s+src="\/docs\/sub-[^/]+\/clip\.m4v"/);
    expect(text).not.toMatch(/controls(=|\s|\/>|>)/);

    const videoEl = page.locator('.ProseMirror video[src*="/clip.m4v"]').first();
    await videoEl.waitFor({ state: 'visible', timeout: 5_000 });
    const src = await videoEl.getAttribute('src');
    expect(src).toMatch(/^\/docs\/sub-[^/]+\/clip\.m4v$/);

    const res = await page.request.get(src ?? '');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toBe('inline');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['content-type'] ?? '').toMatch(/^video\/mp4/);
  });

  test('P9.22: missing asset URL returns 404, not the SPA fallback editor shell (2026-04-24b)', async ({
    page,
  }) => {
    const res = await page.request.get('/definitely-not-there.m4v');
    expect(res.status()).toBe(404);
    const contentType = res.headers()['content-type'] ?? '';
    expect(contentType).not.toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).not.toContain('id="root"');
  });
});
