import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  createMp3Buffer,
  createMp4Buffer,
  createPngBuffer,
  expect,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

/** Open the PropPanel for the (only) component block on the page by
 *  clicking its settings gear. Returns the panel locator scoped to the
 *  Radix portal under document.body.
 *
 *  Chrome opacity is 0 by default and only goes to 1 on `:hover` or when
 *  the wrapper has `data-selected="true"` (`globals.css`). For img blocks,
 *  the inner `<span data-rmiz>` (medium-zoom wrapper) intercepts pointer
 *  events on the image content itself — so we hover the wrapper to surface
 *  the chrome, then click the gear with `force: true` to bypass the
 *  pointer-events-intercept check (Playwright's actionability gate). The
 *  gear button is positioned at top:-11px above the wrapper, OUTSIDE the
 *  medium-zoom span's bounding box, so the click lands cleanly on it. */
async function openPropPanel(page: Page): Promise<ReturnType<Page['locator']>> {
  const wrapper = page.locator('[data-jsx-component]').first();
  await wrapper.waitFor({ state: 'visible', timeout: 5000 });
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click({ force: true });
  const panel = page.locator('[data-prop-panel]').first();
  await panel.waitFor({ state: 'visible', timeout: 5000 });
  return panel;
}

/** Read the current `src` value of the (single) media element on the page.
 *  Works for `<img>`, `<video>`, `<audio>` — each renders with an `src`
 *  attribute on the tag itself or on a child source element. */
async function readSrc(page: Page, tag: 'img' | 'video' | 'audio'): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLMediaElement | HTMLImageElement | null;
    if (!el) return '';
    return el.getAttribute('src') ?? '';
  }, tag);
}

/** Wait for the media element's `src` attribute to differ from the prior
 *  value. Polls via the page's MutationObserver-equivalent (Playwright's
 *  `waitForFunction`). */
async function waitForSrcChange(
  page: Page,
  tag: 'img' | 'video' | 'audio',
  prior: string,
  timeoutMs = 8000,
): Promise<string> {
  await page.waitForFunction(
    ([sel, prev]) => {
      const el = document.querySelector(sel as string);
      const cur = el?.getAttribute('src') ?? '';
      return cur && cur !== prev;
    },
    [tag, prior],
    { timeout: timeoutMs },
  );
  return readSrc(page, tag);
}

interface UploadCase {
  tag: 'img' | 'video' | 'audio';
  endpoint: '/api/upload';
  initialMarkdown: string;
  initialSrc: string;
  /** Two distinct payloads — the test uploads both in sequence to exercise
   *  initial replace AND second replace through the same wiring. */
  payloads: Array<{ name: string; mimeType: string; buffer: Buffer }>;
}

const cases: Record<'img' | 'video' | 'audio', UploadCase> = {
  img: {
    tag: 'img',
    endpoint: '/api/upload',
    initialMarkdown: '<img src="initial.png" alt="initial" />',
    initialSrc: 'initial.png',
    payloads: [
      { name: 'first.png', mimeType: 'image/png', buffer: createPngBuffer('first') },
      { name: 'second.png', mimeType: 'image/png', buffer: createPngBuffer('second') },
    ],
  },
  video: {
    tag: 'video',
    endpoint: '/api/upload',
    initialMarkdown: '<video src="initial.mp4" controls />',
    initialSrc: 'initial.mp4',
    payloads: [
      { name: 'first.mp4', mimeType: 'video/mp4', buffer: createMp4Buffer('first') },
      { name: 'second.mp4', mimeType: 'video/mp4', buffer: createMp4Buffer('second') },
    ],
  },
  audio: {
    tag: 'audio',
    endpoint: '/api/upload',
    initialMarkdown: '<audio src="initial.mp3" controls />',
    initialSrc: 'initial.mp3',
    payloads: [
      { name: 'first.mp3', mimeType: 'audio/mpeg', buffer: createMp3Buffer('first') },
      { name: 'second.mp3', mimeType: 'audio/mpeg', buffer: createMp3Buffer('second') },
    ],
  },
};

for (const kind of ['img', 'video', 'audio'] as const) {
  const c = cases[kind];

  test(`UPLOAD-${kind.toUpperCase()}-01: PropPanel upload replaces src and lands on disk`, async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = `prop-upload-${kind}-${randomUUID().slice(0, 8)}`;
    await api.seedDocs([{ name: docName, markdown: c.initialMarkdown }]);
    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror');
    await waitForActiveProviderSynced(page);

    expect(await readSrc(page, c.tag)).toBe(c.initialSrc);

    const panel = await openPropPanel(page);
    const fileInput = panel.locator('[data-prop-upload-input]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 5000 });

    await fileInput.setInputFiles({
      name: c.payloads[0].name,
      mimeType: c.payloads[0].mimeType,
      buffer: c.payloads[0].buffer,
    });
    const srcAfterFirst = await waitForSrcChange(page, c.tag, c.initialSrc);
    expect(srcAfterFirst).not.toBe(c.initialSrc);
    expect(srcAfterFirst.startsWith('/')).toBe(true);
    expect(srcAfterFirst).toContain(c.payloads[0].name.replace(/\.\w+$/, ''));
    expect(existsSync(join(workerServer.contentDir, srcAfterFirst.replace(/^\//, '')))).toBe(true);

    await fileInput.setInputFiles({
      name: c.payloads[1].name,
      mimeType: c.payloads[1].mimeType,
      buffer: c.payloads[1].buffer,
    });
    const srcAfterSecond = await waitForSrcChange(page, c.tag, srcAfterFirst);
    expect(srcAfterSecond).not.toBe(srcAfterFirst);
    expect(srcAfterSecond.startsWith('/')).toBe(true);
    expect(srcAfterSecond).toContain(c.payloads[1].name.replace(/\.\w+$/, ''));
    expect(existsSync(join(workerServer.contentDir, srcAfterSecond.replace(/^\//, '')))).toBe(true);
  });
}

test('UPLOAD-IMG-SUBDIR-01: subdir-doc upload renders <img> that fetches the asset (not SPA fallback)', async ({
  page,
  api,
  workerServer,
}) => {
  expect(existsSync(join(workerServer.contentDir, 'sidebar-folder', 'nested-doc.md'))).toBe(true);

  const docName = `sidebar-folder/upload-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: cases.img.initialMarkdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);

  expect(await readSrc(page, 'img')).toBe(cases.img.initialSrc);

  const panel = await openPropPanel(page);
  const fileInput = panel.locator('[data-prop-upload-input]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 5000 });

  await fileInput.setInputFiles({
    name: cases.img.payloads[0].name,
    mimeType: cases.img.payloads[0].mimeType,
    buffer: cases.img.payloads[0].buffer,
  });

  const newSrc = await waitForSrcChange(page, 'img', cases.img.initialSrc);
  expect(newSrc).not.toBe(cases.img.initialSrc);

  expect(newSrc).toContain('sidebar-folder/');

  expect(existsSync(join(workerServer.contentDir, newSrc.replace(/^\//, '')))).toBe(true);

  const baseURL = page.url().split('#')[0]; // strip hash
  const resolved = new URL(newSrc, baseURL).toString();
  const response = await page.request.get(resolved);
  expect(response.status()).toBe(200);
  const contentType = response.headers()['content-type'] ?? '';
  expect(contentType).toMatch(/^image\//);
});

test('UPLOAD-IMG-ERR: 0-byte upload → 400 No file received → toast.error → src unchanged', async ({
  page,
  api,
}) => {
  const docName = `prop-upload-err-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: cases.img.initialMarkdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);

  expect(await readSrc(page, 'img')).toBe(cases.img.initialSrc);

  const panel = await openPropPanel(page);
  const fileInput = panel.locator('[data-prop-upload-input]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 5000 });

  await fileInput.setInputFiles({
    name: 'empty.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(0),
  });

  const toast = page.locator('[data-sonner-toast]', { hasText: /upload failed/i }).first();
  await toast.waitFor({ state: 'visible', timeout: 5000 });

  expect(await readSrc(page, 'img')).toBe(cases.img.initialSrc);
});
