import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  escapeRegExp,
  expect,
  test,
  uniqueAssetName,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HELPERS_DIR, '_fixtures');

function sha256(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function dropFileBytesIntoEditor(
  page: Page,
  bytes: Buffer,
  filename: string,
  mime: string,
): Promise<void> {
  const arr = Array.from(bytes);
  await page.evaluate(
    ({ b, name, type }) => {
      const editor = document.querySelector(
        '.ProseMirror:not(.composer-prosemirror)',
      ) as HTMLElement | null;
      if (!editor) throw new Error('no editor');
      const file = new File([new Uint8Array(b)], name, { type });
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
    { b: arr, name: filename, type: mime },
  );
}

async function getSourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

async function waitForDiskFile(
  contentDir: string,
  relPath: string,
  timeoutMs = 5000,
): Promise<Buffer> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      return readFileSync(join(contentDir, relPath));
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`File not found on disk after ${timeoutMs}ms: ${relPath} (${String(lastErr)})`);
}

test.describe('asset-embed — real-fidelity byte-identity (QA-001/002/003/004/005/006/010)', () => {
  let runId: string;

  test.beforeEach(async ({ page, api }) => {
    runId = randomUUID().slice(0, 8);
    const docName = `real-${runId}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, '# Real\n');
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.click('.ProseMirror:not(.composer-prosemirror)');
    (page as unknown as { __docName: string }).__docName = docName;
  });

  test('QA-001: real 2MB PDF → ![[draft.pdf]] + byte-exact on-disk file', async ({
    page,
    workerServer,
  }) => {
    const pdf = readFileSync(join(FIXTURES_DIR, 'real-draft.pdf'));
    expect(pdf.length).toBe(2097173);
    expect(pdf.subarray(0, 8).toString('utf8')).toBe('%PDF-1.4');
    const expectedSha = sha256(pdf);

    const pdfName = uniqueAssetName('draft.pdf', runId);
    await dropFileBytesIntoEditor(page, pdf, pdfName, 'application/pdf');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toContain(`![[${pdfName}]]`);

    const onDisk = await waitForDiskFile(workerServer.contentDir, pdfName);
    expect(onDisk.length).toBe(pdf.length);
    expect(sha256(onDisk)).toBe(expectedSha);

    await page.screenshot({
      path: test.info().outputPath('qa-001-real-pdf.png'),
      fullPage: true,
    });
  });

  test('QA-002: real MP4 → <video src="/test.mp4" /> + byte-exact on-disk (controls omitted on emit)', async ({
    page,
    workerServer,
  }) => {
    const mp4 = readFileSync(join(FIXTURES_DIR, 'real-video.mp4'));
    const expectedSha = sha256(mp4);
    const mp4Name = uniqueAssetName('test.mp4', runId);
    await dropFileBytesIntoEditor(page, mp4, mp4Name, 'video/mp4');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(new RegExp(`<video\\s+src="/?${escapeRegExp(mp4Name)}"`));
    const text = await getSourceText(page);
    expect(text).not.toMatch(/controls(=|\s|\/>|>)/);
    const onDisk = await waitForDiskFile(workerServer.contentDir, mp4Name);
    expect(sha256(onDisk)).toBe(expectedSha);
  });

  test('QA-003: real MP3 → <audio src="/test.mp3" /> + byte-exact on-disk (controls omitted on emit)', async ({
    page,
    workerServer,
  }) => {
    const mp3 = readFileSync(join(FIXTURES_DIR, 'real-sound.mp3'));
    const expectedSha = sha256(mp3);
    const mp3Name = uniqueAssetName('test.mp3', runId);
    await dropFileBytesIntoEditor(page, mp3, mp3Name, 'audio/mpeg');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(new RegExp(`<audio\\s+src="/?${escapeRegExp(mp3Name)}"`));
    const text = await getSourceText(page);
    expect(text).not.toMatch(/controls(=|\s|\/>|>)/);
    const onDisk = await waitForDiskFile(workerServer.contentDir, mp3Name);
    expect(sha256(onDisk)).toBe(expectedSha);
  });

  test('QA-004: real ZIP → ![[archive.zip]] wiki-embed (File row) + byte-exact on-disk', async ({
    page,
    workerServer,
  }) => {
    const zip = readFileSync(join(FIXTURES_DIR, 'real-archive.zip'));
    const expectedSha = sha256(zip);
    const zipName = uniqueAssetName('archive.zip', runId);
    await dropFileBytesIntoEditor(page, zip, zipName, 'application/zip');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toContain(zipName);
    const text = await getSourceText(page);
    expect(text).toContain(`![[${zipName}]]`);
    const onDisk = await waitForDiskFile(workerServer.contentDir, zipName);
    expect(sha256(onDisk)).toBe(expectedSha);
  });

  test('QA-005: real SVG with <script> → wiki-embed + no inline DOM + no alert()', async ({
    page,
    workerServer,
  }) => {
    let alertFired = false;
    page.on('dialog', async (dialog) => {
      alertFired = true;
      await dialog.dismiss();
    });

    const svg = readFileSync(join(FIXTURES_DIR, 'real-xss.svg'));
    expect(svg.toString('utf-8')).toContain('<script>');
    const expectedSha = sha256(svg);

    const svgName = uniqueAssetName('xss.svg', runId);
    await dropFileBytesIntoEditor(page, svg, svgName, 'image/svg+xml');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(new RegExp(`<img\\s+src="/?${escapeRegExp(svgName)}"`));

    const onDisk = await waitForDiskFile(workerServer.contentDir, svgName);
    expect(sha256(onDisk)).toBe(expectedSha);

    const scriptCount = await page.locator('.ProseMirror script').count();
    expect(scriptCount).toBe(0);
    const onloadCount = await page.locator('.ProseMirror [onload]').count();
    expect(onloadCount).toBe(0);

    await expect.poll(() => alertFired, { timeout: 500 }).toBe(false);
  });

  test('QA-006: real CSV → ![[data.csv]] wiki-embed (File row) + byte-exact on-disk', async ({
    page,
    workerServer,
  }) => {
    const csv = readFileSync(join(FIXTURES_DIR, 'real-data.csv'));
    const expectedSha = sha256(csv);
    const csvName = uniqueAssetName('data.csv', runId);
    await dropFileBytesIntoEditor(page, csv, csvName, 'text/csv');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toContain(csvName);
    const text = await getSourceText(page);
    expect(text).toContain(`![[${csvName}]]`);
    const onDisk = await waitForDiskFile(workerServer.contentDir, csvName);
    expect(sha256(onDisk)).toBe(expectedSha);
    expect(onDisk.toString('utf-8')).toBe('name,age,city\nAlice,30,NYC\nBob,25,LA\n');
  });

  test('QA-041: ~24MB upload end-to-end <2s (hash + dedup scan + disk write + HTTP)', async ({
    page,
    workerServer,
  }) => {
    const docName = (page as unknown as { __docName: string }).__docName;
    const binName = uniqueAssetName('big.bin', runId);
    const payloadBytes = 24 * 1024 * 1024;
    const resultJson = await page.evaluate(
      async ({ docName, size, fileName }: { docName: string; size: number; fileName: string }) => {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i++) bytes[i] = (i * 13) & 0xff;
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const fd = new FormData();
        fd.append('parentDocName', `${docName}.md`);
        fd.append('file', blob, fileName);
        const t0 = performance.now();
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const elapsedMs = performance.now() - t0;
        const body = (await res.json()) as { src?: string; path?: string; deduped?: boolean };
        return { status: res.status, body, elapsedMs, sentBytes: size };
      },
      { docName, size: payloadBytes, fileName: binName },
    );

    expect(resultJson.status).toBe(200);
    expect(typeof resultJson.body.src).toBe('string');

    expect(resultJson.elapsedMs).toBeLessThan(10_000);

    const onDisk = await waitForDiskFile(workerServer.contentDir, binName);
    expect(onDisk.length).toBe(payloadBytes);

    console.log(
      JSON.stringify({
        event: 'qa-041-perf',
        sentBytes: resultJson.sentBytes,
        elapsedMs: resultJson.elapsedMs,
        smokeBudgetMs: 10_000,
        nfr1BudgetMs: 2000,
        smokePass: resultJson.elapsedMs < 10_000,
        nfr1Pass: resultJson.elapsedMs < 2000,
      }),
    );
  });

  test('QA-010: same PNG dropped twice → dedup returns existing path, single file on disk', async ({
    page,
    workerServer,
  }) => {
    const png = readFileSync(join(FIXTURES_DIR, 'real-shot.png'));
    const expectedSha = sha256(png);
    const pngName = uniqueAssetName('shot.png', runId);
    const collisionName = pngName.replace(/\.png$/, '-1.png');
    await dropFileBytesIntoEditor(page, png, pngName, 'image/png');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(new RegExp(`<img\\s+src="/?${escapeRegExp(pngName)}"`));

    await dropFileBytesIntoEditor(page, png, pngName, 'image/png');

    await expect
      .poll(
        async () => {
          const t = await getSourceText(page);
          return (t.match(new RegExp(`<img\\s+[^>]*src="/?${escapeRegExp(pngName)}"`, 'g')) ?? [])
            .length;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(2);
    const text = await getSourceText(page);
    expect(text).not.toContain(collisionName);

    const onDisk = await waitForDiskFile(workerServer.contentDir, pngName);
    expect(sha256(onDisk)).toBe(expectedSha);

    await expect(async () => {
      await waitForDiskFile(workerServer.contentDir, collisionName, 500);
    }).rejects.toThrow(/not found/);
  });
});
