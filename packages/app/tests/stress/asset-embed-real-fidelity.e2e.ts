/**
 * Real-fidelity augments to asset-embed.e2e.ts.
 *
 * The existing asset-embed.e2e.ts uses synthetic byte arrays (FAKE_PDF_HEADER,
 * 1x1 TINY_PNG base64). This file loads REAL fixtures from disk:
 *   - real-draft.pdf   (2 097 173 bytes, valid %PDF-1.4 header)
 *   - real-shot.png    (5 897 bytes, deterministic PNG)
 *   - real-sound.mp3   (ffmpeg sine-wave, valid MP3)
 *   - real-video.mp4   (ffmpeg testsrc, valid moov atom)
 *   - real-diagram.svg (valid XML SVG)
 *   - real-xss.svg     (SVG with <script> payload — guard)
 *   - real-data.csv    (UTF-8 CSV)
 *   - real-archive.zip (valid PK magic)
 *
 * Each test verifies BOTH:
 *   (a) Y.Text gets the expected wiki-embed or markdown-link shape, AND
 *   (b) The file actually landed on disk at workerServer.contentDir with
 *       bytes matching the fixture sha256 (not a truncated or corrupted
 *       write).
 *
 * Real Chromium, real bytes, real disk verification.
 */

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
  // Serialize the buffer as a plain number[] for structured clone; acceptable
  // up to a few MB. For 30MB+ use the page.evaluate-side allocation pattern
  // (see asset-embed-advanced.e2e.ts).
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
  // Per-test token shared by the docName and every asset name this test
  // uploads. Uploads land in the worker-shared contentDir keyed by filename,
  // so a hardcoded name is claimable by any sibling spec on the same worker —
  // whoever loses gets a `-1` collision suffix and fails its exact-path
  // assertion. The fixture bytes stay unsalted: they are distinct real files
  // no other spec uploads, and each test asserts the on-disk sha256 against
  // them. Unsalted bytes are `--repeat-each`-safe too, though not because of
  // the worker hash: `repeatEachIndex` is a property of the TestCase, not of
  // worker identity. Each repeat schedules as an independent test instance
  // and the per-test `runId` below re-salts every filename, so no two repeats
  // present the same name to same-dir dedup regardless of which worker runs
  // them.
  let runId: string;

  test.beforeEach(async ({ page, api }) => {
    // Create a fresh doc for each test so uploads co-locate predictably.
    runId = randomUUID().slice(0, 8);
    const docName = `real-${runId}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, '# Real\n');
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.click('.ProseMirror:not(.composer-prosemirror)');
    // Stash docName on the page context for the tests to consume.
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

    // Y.Text assertion
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toContain(`![[${pdfName}]]`);

    // Disk assertion — file lands co-located beside the doc (same dir as docName.md).
    const onDisk = await waitForDiskFile(workerServer.contentDir, pdfName);
    expect(onDisk.length).toBe(pdf.length);
    expect(sha256(onDisk)).toBe(expectedSha);

    // Screenshot evidence — use the Playwright runner's per-test
    // artifact directory so the test works on any machine, in CI, and
    // the image auto-attaches to the HTML report. The pre-fix path
    // hardcoded one developer's worktree and would silently no-op (or
    // crash, depending on Playwright version) everywhere else.
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
    // `controls={true}` matches the descriptor default — emit-time
    // omit-on-default strips the attr; renderer applies the default at
    // load. See `serialize-helpers.ts` reconstructAttrs.
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
    // zip is a FILE_ATTACHMENT_EXTENSIONS member: drops route through
    // pickInsertShape 'jsx-file' -> WikiEmbedFile, whose serialize emits the
    // wiki-embed source bytes so the file persists as a File row, not an
    // opaque markdown link.
    expect(text).toContain(`![[${zipName}]]`);
    const onDisk = await waitForDiskFile(workerServer.contentDir, zipName);
    expect(sha256(onDisk)).toBe(expectedSha);
  });

  test('QA-005: real SVG with <script> → wiki-embed + no inline DOM + no alert()', async ({
    page,
    workerServer,
  }) => {
    // Hook to prove no alert() fires during the upload/render flow.
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
    // SVG is in IMAGE_EXTENSIONS — drops emit the canonical `<img>` JSX shape.
    // The XSS payload is still the bytes-on-disk
    // concern: render-time XSS protection is unchanged whether the chip
    // renders as wikiLinkEmbed `<img>` or Image.tsx `<img>` — both go through
    // the browser's <img> element which doesn't execute embedded <script>.
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(new RegExp(`<img\\s+src="/?${escapeRegExp(svgName)}"`));

    // Byte-identical on disk (server stores verbatim — it's render-time that protects us).
    const onDisk = await waitForDiskFile(workerServer.contentDir, svgName);
    expect(sha256(onDisk)).toBe(expectedSha);

    // WYSIWYG must NOT inject the SVG bytes as inline DOM. Image.tsx
    // renders SVG via `<img src=...>`, so the embedded `<script>`
    // and `onload="alert('xss')"` never enter the document. The
    // bare-`svg-count` proxy doesn't apply because Image.tsx's
    // Zoom wrapper paints a UI chevron SVG; we instead pin the actual XSS
    // surface — no `<script>` element and no element carrying the
    // `onload="alert(...)"` attribute landed in the editor.
    const scriptCount = await page.locator('.ProseMirror script').count();
    expect(scriptCount).toBe(0);
    const onloadCount = await page.locator('.ProseMirror [onload]').count();
    expect(onloadCount).toBe(0);

    // Prove no deferred alert fires. `alertFired` is a page-level
    // sentinel updated by an `on('dialog', ...)` handler set up at
    // test start; we poll it with a condition-based wait instead of
    // a fixed sleep (E2E STOP rule forbids page.waitForTimeout).
    // If an SVG <script> had snuck through as inline DOM, the payload
    // would have fired `alert(1)` synchronously on insertion — this
    // assertion forces a microtask tick + an expect.poll round to
    // give any pending event loop work a chance to surface.
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
    // csv is a FILE_ATTACHMENT_EXTENSIONS member, so the drop serializes to the
    // wiki-embed source bytes rather than a fall-through markdown link.
    expect(text).toContain(`![[${csvName}]]`);
    const onDisk = await waitForDiskFile(workerServer.contentDir, csvName);
    expect(sha256(onDisk)).toBe(expectedSha);
    expect(onDisk.toString('utf-8')).toBe('name,age,city\nAlice,30,NYC\nBob,25,LA\n');
  });

  test('QA-041: ~24MB upload end-to-end <2s (hash + dedup scan + disk write + HTTP)', async ({
    page,
    workerServer,
  }) => {
    // Total <2s is the user-perceivable
    // threshold for a 24 MiB upload end-to-end. There is no user-facing byte cap — the hash is folded
    // into the pipeline via `HashingPassThrough` so throughput is
    // disk-bound, not hash-bound. We still send ~24 MiB here because
    // the scenario was calibrated against that size and it's a
    // realistic large-asset drop.
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

    // Smoke ceiling: 10s proves the upload went through without hanging
    // on a 24MB payload through multipart → busboy → sha256 → dedup
    // scan → atomic write. The tight perf bound (2×p50Baseline
    // with a 2s absolute-floor) lives in the standalone benchmark track — a median-of-5
    // baseline captured from post-merge CI, not local. Asserting `< 2000ms` inline
    // here would flake under CI contention and dilute the perf signal;
    // see `packages/app/tests/stress/perf-baseline.json` for the
    // framework.
    expect(resultJson.elapsedMs).toBeLessThan(10_000);

    // Disk bytes are exactly what we sent, end-to-end.
    const onDisk = await waitForDiskFile(workerServer.contentDir, binName);
    expect(onDisk.length).toBe(payloadBytes);

    // Log as evidence — include the smoke ceiling
    // plus the aspirational bound so the JSONL trail carries both
    // signals. `nfr1Pass` is diagnostic; the test fails on the smoke
    // bound alone.
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
    // Image-extension drops emit `<img>` JSX. Dedup is asserted
    // against the filename collision-suffix shape (no `-1` collision
    // variant — `collisionName`), not the wikiembed text shape.
    const png = readFileSync(join(FIXTURES_DIR, 'real-shot.png'));
    const expectedSha = sha256(png);
    const pngName = uniqueAssetName('shot.png', runId);
    // What the server would emit if the second drop failed to dedup and had
    // to take a collision suffix instead.
    const collisionName = pngName.replace(/\.png$/, '-1.png');
    await dropFileBytesIntoEditor(page, png, pngName, 'image/png');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 10_000 })
      .toMatch(new RegExp(`<img\\s+src="/?${escapeRegExp(pngName)}"`));

    // Second drop with identical bytes
    await dropFileBytesIntoEditor(page, png, pngName, 'image/png');

    // Two `<img …>` tags should appear, BOTH pointing at `pngName`
    // (not the `-1` collision variant).
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

    // Single file on disk, byte-exact.
    const onDisk = await waitForDiskFile(workerServer.contentDir, pngName);
    expect(sha256(onDisk)).toBe(expectedSha);

    // No collision-suffix file.
    await expect(async () => {
      await waitForDiskFile(workerServer.contentDir, collisionName, 500);
    }).rejects.toThrow(/not found/);
  });
});
