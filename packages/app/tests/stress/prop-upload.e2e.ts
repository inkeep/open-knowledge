/**
 * PropPanel upload affordance — end-to-end coverage for img/video/audio.
 *
 * Covers the full UI → server → disk → render path that no lower tier
 * exercises:
 *
 *  - The PropUploadButton's hidden `<input type="file">` is wired through
 *    `runUpload` → `uploadFile` → real fetch to the unified `/api/upload`
 *    endpoint (accept-all by extension; one route for all media kinds).
 *  - The server's magic-byte sniffing accepts a real multipart body shaped
 *    by Chromium's file-input + FormData (not a hand-crafted Buffer like
 *    the unit test).
 *  - The returned `{ ok, src, path, deduped }` propagates through
 *    `onUploaded` → `onChange` → Y.Doc → re-render of the descriptor's
 *    React component with new src (`uploadFile` unwraps `path ?? src`
 *    into `{ url }`).
 *  - Cross-medium parity: each descriptor's wiring is independent (different
 *    `accept` array, same endpoint) and a video-specific regression
 *    won't show in image-only coverage.
 *
 * Initial-insert AND replace-src are both exercised in the same flow per
 * medium: seed a doc with a placeholder src, upload one buffer (replaces
 * src), upload a second buffer (replaces again). The PropUploadButton
 * code path is the same for empty-initial-src vs populated-initial-src;
 * the bug class unique to "replace existing" is `PropPanel.onChange
 * mutating attrs of an existing block` which is already covered by every
 * existing PropPanel-attr-change test.
 *
 * The ERROR-PATH variant on UPLOAD-IMG exercises the catch arm in
 * `runUpload` (server 400 → toast) without needing a `Promise.reject(...)`
 * mock at the unit tier — that's the `bun:test` unhandled-rejection
 * observer trap. Trigger is a 0-byte file
 * (server's `byteLength === 0` → 400 'No file received') because the
 * unified `/api/upload` endpoint is accept-all and the prior
 * magic-byte-mismatch rejection no longer applies.
 *
 * This file is NOT in the CI `test:e2e` file list
 * (`packages/app/package.json` dispatches a fixed subset for PR-tier runs);
 * generic `bunx playwright test` invocations run it for pre-push coverage,
 * and the nightly E2E stability surveillance picks up flakes.
 */

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    // For <video>/<audio>, the src may be on the element OR on a <source>
    // child. PropPanel sets it on the element directly (no <source>
    // children) so the attribute read suffices.
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
  // All media kinds route through the unified `/api/upload` endpoint.
  // Retained as a field (not a const) so any future per-kind divergence has a
  // single, obvious lever to flip.
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
    // Distinct salts so the two payloads differ in sha256; HEAD's `/api/upload`
    // same-dir dedup would otherwise collapse byte-identical buffers to one
    // stored file, leaving src unchanged on the second upload.
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

// ---------------------------------------------------------------------------
// UPLOAD-{IMG,VID,AUD}-01 — happy path: replace src twice through PropPanel
// ---------------------------------------------------------------------------

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
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await waitForActiveProviderSynced(page);

    // Initial src is the seeded placeholder.
    expect(await readSrc(page, c.tag)).toBe(c.initialSrc);

    const panel = await openPropPanel(page);
    const fileInput = panel.locator('[data-prop-upload-input]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 5000 });

    // First upload — initial → first payload.
    await fileInput.setInputFiles({
      name: c.payloads[0].name,
      mimeType: c.payloads[0].mimeType,
      buffer: c.payloads[0].buffer,
    });
    const srcAfterFirst = await waitForSrcChange(page, c.tag, c.initialSrc);
    expect(srcAfterFirst).not.toBe(c.initialSrc);
    // Server returns the contentDir-relative `path` (POSIX-normalized, no
    // leading slash from `relative()`); the upload-file.ts client helper
    // prefixes `/` to root the URL at origin so subdir docs referencing
    // peer-dir assets resolve correctly under hash routing. Mirror of the
    // drop path's `resolvedSrc = `/${assetContentPath}``.
    expect(srcAfterFirst.startsWith('/')).toBe(true);
    expect(srcAfterFirst).toContain(c.payloads[0].name.replace(/\.\w+$/, ''));
    // Strip the leading `/` before joining with the contentDir.
    expect(existsSync(join(workerServer.contentDir, srcAfterFirst.replace(/^\//, '')))).toBe(true);

    // Second upload — first payload → second payload. Same wiring path,
    // but starting from a populated src (initial-vs-update parity).
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

// ---------------------------------------------------------------------------
// UPLOAD-IMG-SUBDIR-01 — doc in a subdir uploads + browser-fetches the file
//
// Regression guard for the doc-relative-URL bug: if the server returns a
// bare filename (`foo.png`) instead of a server-absolute path
// (`/subdir/foo.png`), the renderer's `<img src="foo.png">` resolves
// against the page base (`http://localhost:5173/` — hash fragment doesn't
// affect URL base) and fetches `localhost:5173/foo.png`. sirv looks at
// contentDir root, doesn't find it, falls through to Vite's SPA fallback
// which returns index.html with text/html — the `<img>` shows broken-icon.
//
// UPLOAD-IMG-01 above doesn't catch this because it seeds at contentDir
// root (no subdir), so bare-filename and server-absolute paths happen to
// coincide. This test puts the doc in a subdir so the two paths diverge,
// and verifies the rendered <img>'s src actually resolves to the file
// (Content-Type starts with image/, not text/html).
//
// Uses the worker fixture's pre-seeded `sidebar-folder/` (created at
// `_helpers/fixtures.ts:171` `seedRequiredFixtureFiles`, which writes
// `sidebar-folder/nested-doc.md` at worker boot) so the content
// filter's `dirCount[sidebar-folder]` is warm by the time the test
// runs. Freshly-created subdirs
// hit a separate filter race (parcel-watcher's async `create` event lags
// the synchronous `/api/create-page` response by hundreds of ms, leaving
// dirCount stale during the upload window), so this test pins to a
// pre-warmed subdir.
// ---------------------------------------------------------------------------

test('UPLOAD-IMG-SUBDIR-01: subdir-doc upload renders <img> that fetches the asset (not SPA fallback)', async ({
  page,
  api,
  workerServer,
}) => {
  // Pre-condition guard: the worker fixture seeds `sidebar-folder/nested-doc.md`
  // at boot (via `seedRequiredFixtureFiles`). If the
  // seed is missing, the content filter's `dirCount[sidebar-folder]` is cold
  // and the upload returns 400 from the filter rather than from the path-escape
  // / MIME validation under test. Fail-fast here so the failure points at the
  // missing prerequisite instead of the upload step.
  expect(existsSync(join(workerServer.contentDir, 'sidebar-folder', 'nested-doc.md'))).toBe(true);

  const docName = `sidebar-folder/upload-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: cases.img.initialMarkdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
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

  // Subdir is threaded through `path` (contentDir-relative, no leading
  // slash). The bare-filename regression class manifests when src omits the
  // subdir entirely (`first.png` instead of `sidebar-folder/first.png`) —
  // this assertion guards the "doc subdir is preserved" invariant
  // regardless of leading-slash style.
  expect(newSrc).toContain('sidebar-folder/');

  // The file must exist on disk under the doc's subdir. Strip a leading `/`
  // defensively before joining.
  expect(existsSync(join(workerServer.contentDir, newSrc.replace(/^\//, '')))).toBe(true);

  // Critical: when the browser resolves <img src=...>, it must hit the
  // actual file (Content-Type: image/*), not Vite's SPA fallback
  // (Content-Type: text/html). This is the regression that bare-filename
  // src would silently fail.
  const baseURL = page.url().split('#')[0]; // strip hash
  const resolved = new URL(newSrc, baseURL).toString();
  const response = await page.request.get(resolved);
  expect(response.status()).toBe(200);
  const contentType = response.headers()['content-type'] ?? '';
  expect(contentType).toMatch(/^image\//);
});

// ---------------------------------------------------------------------------
// UPLOAD-IMG-ERR — server-side rejection surfaces toast.error, src unchanged.
// Exercises runUpload's catch arm (`String(err)` fallback) without a
// mock-driven `Promise.reject(...)` (the Bun observer-bleed trap).
//
// Trigger: 0-byte upload. The unified `/api/upload` endpoint is accept-all
// (no MIME-prefix gate), so the prior PDF-magic-bytes-as-PNG trigger no
// longer fails — the server happily accepts it. An empty file is the
// cleanest server-side rejection accessible from the PropPanel UI:
// `byteLength === 0` → 400 'No file received' (api-extension.ts).
// PathName-escape rejections require manipulating `parentDocName`, which
// the PropPanel UI doesn't expose.
// ---------------------------------------------------------------------------

test('UPLOAD-IMG-ERR: 0-byte upload → 400 No file received → toast.error → src unchanged', async ({
  page,
  api,
}) => {
  const docName = `prop-upload-err-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: cases.img.initialMarkdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await waitForActiveProviderSynced(page);

  expect(await readSrc(page, 'img')).toBe(cases.img.initialSrc);

  const panel = await openPropPanel(page);
  const fileInput = panel.locator('[data-prop-upload-input]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 5000 });

  // Empty buffer + .png filename. Server admits the upload past the
  // multipart parser (filename + MIME pass), then short-circuits at
  // `byteLength === 0` → 400 'No file received'. runUpload's catch arm
  // surfaces this through Sonner.
  await fileInput.setInputFiles({
    name: 'empty.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(0),
  });

  // Sonner toast surfaces with `Upload failed: <server message>` per
  // runUpload's catch arm. The toast lives outside the editor in a
  // top-level container; selector matches sonner's default DOM shape.
  const toast = page.locator('[data-sonner-toast]', { hasText: /upload failed/i }).first();
  await toast.waitFor({ state: 'visible', timeout: 5000 });

  // src must NOT have changed — the rejection short-circuited before
  // `onUploaded(url)` could run.
  expect(await readSrc(page, 'img')).toBe(cases.img.initialSrc);
});
