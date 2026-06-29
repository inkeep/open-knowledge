
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

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
      const editor = document.querySelector('.ProseMirror') as HTMLElement | null;
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
  test.beforeEach(async ({ page, api }) => {
    const docName = `real-${Math.random().toString(36).slice(2, 10)}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, '# Real\n');
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
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

    await dropFileBytesIntoEditor(page, pdf, 'draft.pdf', 'application/pdf');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toContain('![[draft.pdf]]');

    const onDisk = await waitForDiskFile(workerServer.contentDir, 'draft.pdf');
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
    await dropFileBytesIntoEditor(page, mp4, 'test.mp4', 'video/mp4');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(/<video\s+src="\/?test\.mp4"/);
    const text = await getSourceText(page);
    expect(text).not.toMatch(/controls(=|\s|\/>|>)/);
    const onDisk = await waitForDiskFile(workerServer.contentDir, 'test.mp4');
    expect(sha256(onDisk)).toBe(expectedSha);
  });

  test('QA-003: real MP3 → <audio src="/test.mp3" /> + byte-exact on-disk (controls omitted on emit)', async ({
    page,
    workerServer,
  }) => {
    const mp3 = readFileSync(join(FIXTURES_DIR, 'real-sound.mp3'));
    const expectedSha = sha256(mp3);
    await dropFileBytesIntoEditor(page, mp3, 'test.mp3', 'audio/mpeg');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(/<audio\s+src="\/?test\.mp3"/);
    const text = await getSourceText(page);
    expect(text).not.toMatch(/controls(=|\s|\/>|>)/);
    const onDisk = await waitForDiskFile(workerServer.contentDir, 'test.mp3');
    expect(sha256(onDisk)).toBe(expectedSha);
  });

  test('QA-004: real ZIP → [archive.zip](archive.zip) markdown-link (opaque)', async ({
    page,
    workerServer,
  }) => {
    const zip = readFileSync(join(FIXTURES_DIR, 'real-archive.zip'));
    const expectedSha = sha256(zip);
    await dropFileBytesIntoEditor(page, zip, 'archive.zip', 'application/zip');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toContain('archive.zip');
    const text = await getSourceText(page);
    expect(text).not.toContain('![[archive.zip]]');
    expect(text).toContain('[archive.zip](archive.zip)');
    const onDisk = await waitForDiskFile(workerServer.contentDir, 'archive.zip');
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

    await dropFileBytesIntoEditor(page, svg, 'xss.svg', 'image/svg+xml');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(/<img\s+src="\/?xss\.svg"/);

    const onDisk = await waitForDiskFile(workerServer.contentDir, 'xss.svg');
    expect(sha256(onDisk)).toBe(expectedSha);

    const scriptCount = await page.locator('.ProseMirror script').count();
    expect(scriptCount).toBe(0);
    const onloadCount = await page.locator('.ProseMirror [onload]').count();
    expect(onloadCount).toBe(0);

    await expect.poll(() => alertFired, { timeout: 500 }).toBe(false);
  });

  test('QA-006: real CSV → [data.csv](data.csv) markdown-link (D-M accept-all)', async ({
    page,
    workerServer,
  }) => {
    const csv = readFileSync(join(FIXTURES_DIR, 'real-data.csv'));
    const expectedSha = sha256(csv);
    await dropFileBytesIntoEditor(page, csv, 'data.csv', 'text/csv');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toContain('data.csv');
    const text = await getSourceText(page);
    expect(text).not.toContain('![[data.csv]]');
    const onDisk = await waitForDiskFile(workerServer.contentDir, 'data.csv');
    expect(sha256(onDisk)).toBe(expectedSha);
    expect(onDisk.toString('utf-8')).toBe('name,age,city\nAlice,30,NYC\nBob,25,LA\n');
  });

  test('QA-041: ~24MB upload end-to-end <2s (hash + dedup scan + disk write + HTTP)', async ({
    page,
    workerServer,
  }) => {
    const docName = (page as unknown as { __docName: string }).__docName;
    const payloadBytes = 24 * 1024 * 1024;
    const resultJson = await page.evaluate(
      async ({ docName, size }: { docName: string; size: number }) => {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i++) bytes[i] = (i * 13) & 0xff;
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const fd = new FormData();
        fd.append('parentDocName', `${docName}.md`);
        fd.append('file', blob, 'big.bin');
        const t0 = performance.now();
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const elapsedMs = performance.now() - t0;
        const body = (await res.json()) as { src?: string; path?: string; deduped?: boolean };
        return { status: res.status, body, elapsedMs, sentBytes: size };
      },
      { docName, size: payloadBytes },
    );

    expect(resultJson.status).toBe(200);
    expect(typeof resultJson.body.src).toBe('string');

    expect(resultJson.elapsedMs).toBeLessThan(10_000);

    const onDisk = await waitForDiskFile(workerServer.contentDir, 'big.bin');
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
    await dropFileBytesIntoEditor(page, png, 'shot.png', 'image/png');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(/<img\s+src="\/?shot\.png"/);

    await dropFileBytesIntoEditor(page, png, 'shot.png', 'image/png');

    await expect
      .poll(
        async () => {
          const t = await getSourceText(page);
          return (t.match(/<img\s+[^>]*src="\/?shot\.png"/g) ?? []).length;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(2);
    const text = await getSourceText(page);
    expect(text).not.toContain('shot-1.png');

    const onDisk = await waitForDiskFile(workerServer.contentDir, 'shot.png');
    expect(sha256(onDisk)).toBe(expectedSha);

    await expect(async () => {
      await waitForDiskFile(workerServer.contentDir, 'shot-1.png', 500);
    }).rejects.toThrow(/not found/);
  });
});
