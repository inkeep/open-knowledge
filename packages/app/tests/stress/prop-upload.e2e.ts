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
  uniqueAssetName,
  waitForActiveProviderSynced,
} from './_helpers';

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

async function readSrc(page: Page, tag: 'img' | 'video' | 'audio'): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLMediaElement | HTMLImageElement | null;
    if (!el) return '';
    return el.getAttribute('src') ?? '';
  }, tag);
}

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
  payloads: (runId: string) => Array<{ name: string; mimeType: string; buffer: Buffer }>;
}

const cases: Record<'img' | 'video' | 'audio', UploadCase> = {
  img: {
    tag: 'img',
    endpoint: '/api/upload',
    initialMarkdown: '<img src="initial.png" alt="initial" />',
    initialSrc: 'initial.png',
    payloads: (runId: string) => [
      {
        name: uniqueAssetName('first.png', runId),
        mimeType: 'image/png',
        buffer: createPngBuffer(`first-${runId}`),
      },
      {
        name: uniqueAssetName('second.png', runId),
        mimeType: 'image/png',
        buffer: createPngBuffer(`second-${runId}`),
      },
    ],
  },
  video: {
    tag: 'video',
    endpoint: '/api/upload',
    initialMarkdown: '<video src="initial.mp4" controls />',
    initialSrc: 'initial.mp4',
    payloads: (runId: string) => [
      {
        name: uniqueAssetName('first.mp4', runId),
        mimeType: 'video/mp4',
        buffer: createMp4Buffer(`first-${runId}`),
      },
      {
        name: uniqueAssetName('second.mp4', runId),
        mimeType: 'video/mp4',
        buffer: createMp4Buffer(`second-${runId}`),
      },
    ],
  },
  audio: {
    tag: 'audio',
    endpoint: '/api/upload',
    initialMarkdown: '<audio src="initial.mp3" controls />',
    initialSrc: 'initial.mp3',
    payloads: (runId: string) => [
      {
        name: uniqueAssetName('first.mp3', runId),
        mimeType: 'audio/mpeg',
        buffer: createMp3Buffer(`first-${runId}`),
      },
      {
        name: uniqueAssetName('second.mp3', runId),
        mimeType: 'audio/mpeg',
        buffer: createMp3Buffer(`second-${runId}`),
      },
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
    const runId = randomUUID().slice(0, 8);
    const payloads = c.payloads(runId);
    const docName = `prop-upload-${kind}-${runId}`;
    await api.seedDocs([{ name: docName, markdown: c.initialMarkdown }]);
    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await waitForActiveProviderSynced(page);

    const normalizedInitialSrc = `/${c.initialSrc}`;
    expect(await readSrc(page, c.tag)).toBe(normalizedInitialSrc);

    const panel = await openPropPanel(page);
    const fileInput = panel.locator('[data-prop-upload-input]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 5000 });

    await fileInput.setInputFiles({
      name: payloads[0].name,
      mimeType: payloads[0].mimeType,
      buffer: payloads[0].buffer,
    });
    const srcAfterFirst = await waitForSrcChange(page, c.tag, normalizedInitialSrc);
    expect(srcAfterFirst).not.toBe(c.initialSrc);
    expect(srcAfterFirst.startsWith('/')).toBe(true);
    expect(srcAfterFirst).toContain(payloads[0].name.replace(/\.\w+$/, ''));
    expect(existsSync(join(workerServer.contentDir, srcAfterFirst.replace(/^\//, '')))).toBe(true);

    await fileInput.setInputFiles({
      name: payloads[1].name,
      mimeType: payloads[1].mimeType,
      buffer: payloads[1].buffer,
    });
    const srcAfterSecond = await waitForSrcChange(page, c.tag, srcAfterFirst);
    expect(srcAfterSecond).not.toBe(srcAfterFirst);
    expect(srcAfterSecond.startsWith('/')).toBe(true);
    expect(srcAfterSecond).toContain(payloads[1].name.replace(/\.\w+$/, ''));
    expect(existsSync(join(workerServer.contentDir, srcAfterSecond.replace(/^\//, '')))).toBe(true);
  });
}

test('UPLOAD-IMG-SUBDIR-01: subdir-doc upload renders <img> that fetches the asset (not SPA fallback)', async ({
  page,
  api,
  workerServer,
}) => {
  expect(existsSync(join(workerServer.contentDir, 'sidebar-folder', 'nested-doc.md'))).toBe(true);

  const runId = randomUUID().slice(0, 8);
  const payload = cases.img.payloads(runId)[0];
  const docName = `sidebar-folder/upload-${runId}`;
  await api.seedDocs([{ name: docName, markdown: cases.img.initialMarkdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await waitForActiveProviderSynced(page);

  const normalizedInitialSrc = `/sidebar-folder/${cases.img.initialSrc}`;
  expect(await readSrc(page, 'img')).toBe(normalizedInitialSrc);

  const panel = await openPropPanel(page);
  const fileInput = panel.locator('[data-prop-upload-input]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 5000 });

  await fileInput.setInputFiles({
    name: payload.name,
    mimeType: payload.mimeType,
    buffer: payload.buffer,
  });

  const newSrc = await waitForSrcChange(page, 'img', normalizedInitialSrc);
  expect(newSrc).not.toBe(cases.img.initialSrc);

  expect(newSrc).toContain('sidebar-folder/');

  expect(existsSync(join(workerServer.contentDir, newSrc.replace(/^\//, '')))).toBe(true);

  const baseURL = page.url().split('#')[0];
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
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await waitForActiveProviderSynced(page);

  const normalizedInitialSrc = `/${cases.img.initialSrc}`;
  expect(await readSrc(page, 'img')).toBe(normalizedInitialSrc);

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

  expect(await readSrc(page, 'img')).toBe(normalizedInitialSrc);
});
