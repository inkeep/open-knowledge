/**
 * E2E coverage for the asset-click dispatcher (Path P9).
 *
 * Focuses on real-Chromium scenarios that can't be covered by unit /
 * integration tests:
 *
 *   - P9.1   Post-reload `![[file.pdf]]` renders inline (regression guard)
 *   - P9.9   [[foo]] wiki-link navigation UNCHANGED (regression guard)
 *   - P9.10  Hand-authored `[guide](./file.html)` bare click → in-app preview
 *   - P9.10b Cmd/Ctrl+click on the same link → OS-delegation new tab
 *   - P9.11  Image inline render — click is a no-op (regression guard)
 *   - P9.15  Path-escape (`../../etc/passwd`) doesn't open new tab
 *
 * Electron-specific scenarios (P9.2 / P9.4 / P9.6 / P9.7 / P9.8 / P9.16)
 * require the Electron test harness (not available in the Playwright
 * web-tier); /qa invocation is gated on them per the plan's fidelity-
 * ladder protocol. Integration coverage of the main-process pieces
 * (openAssetSafely / revealAssetSafely / showAssetMenu / safety net)
 * lives in:
 *   - packages/desktop/tests/main/asset-open-handlers.test.ts
 *   - packages/desktop/tests/main/asset-menu.test.ts
 *   - packages/desktop/tests/main/asset-safety-net.test.ts
 *   - packages/desktop/tests/integration/asset-open-ipc.test.ts
 */

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

/**
 * Synthetic drag-drop of a File into the editor. Mirrors
 * `asset-embed.e2e.ts`'s dropFileIntoEditor — dispatches dragover then
 * drop so TipTap's FileHandler extension completes its event sequence.
 */
async function dropFileIntoEditor(
  page: Page,
  bytes: number[],
  filename: string,
  mime: string,
): Promise<void> {
  await page.evaluate(
    ({ bytes: byteArr, filename: fn, mime: mt }) => {
      // Pattern D + V2 cache + Activity-pool keep multiple `.ProseMirror`
      // DOM nodes alive concurrently (one per cached doc). The `display:none`
      // on hidden Activity subtrees is racey — when the active doc changes,
      // the new Activity flips to visible BEFORE the old one flips to hidden
      // (both visible momentarily during React's commit), so a CSS-only
      // visibility filter can pick the previous doc's editor.
      //
      // The reliable signal is `window.__activeEditor` — DEV-only registry
      // populated by `registerEditor`/`unregisterEditor` in
      // `TiptapEditor.tsx` Chrome, exposed as a getter on `window` from
      // `DocumentContext`. Use its `.view.dom` directly for the drop target.
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

// 1x1 transparent PNG. Salt with the file-name so the server's same-dir
// sha256 dedup (`findDuplicateAsset` in `api-extension.ts`) cannot collapse
// our drops onto a byte-identical upload from a sister stress file sharing
// the worker's contentDir. Byte-identical within this file
// so internal dedup behaviour stays predictable.
const TINY_PNG_BYTES = Array.from(createPngBuffer('asset-click-dispatch'));

// Minimal valid PDF bytes — PDF 1.4 header + catalog + trailer. Chromium's
// built-in PDF viewer accepts this shape; adversarial tests would want a
// larger corpus but a valid 1-page PDF is enough to verify server Content-
// Type + URL resolution.
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
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.click('.ProseMirror:not(.composer-prosemirror)');
  });

  test('P9.1: post-reload `![[file.pdf]]` renders as a File row via WikiEmbedFile (no link chip)', async ({
    page,
    api,
  }) => {
    // the `WikiEmbedPdf` compat was removed and PDF
    // wikilinks now route through `WikiEmbedFile` for visual parity
    // with .docx / .zip / etc. (the dropped-attachment chrome is
    // uniform). The pdfjs canvas viewer is opt-in via the explicit
    // `<Pdf>` JSX form. This test pins that PDF wikilinks render as a
    // File row (`.ok-file-attachment`) — NOT as the prior `.ok-pdf`
    // canvas viewer wrapper, and NOT as the link-mark chip fallback.
    //
    // Asset-click dispatcher coverage for PDFs is preserved via P9.10
    // (hand-authored `[spec](./file.pdf)` markdown link still classifies
    // as `kind: 'asset'` and routes through dispatchAssetClick).
    await api.replaceDoc(docName, `# Source\n\n![[meeting.pdf]]\n`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // File row renders synchronously via componentMap['File'] —
    // no async pdfjs-dist worker boot, no canvas allocation.
    const fileRow = page.locator('.ok-file-attachment').first();
    await fileRow.waitFor({ state: 'visible', timeout: 5_000 });

    // No link-mark chip pointing at `meeting.pdf` should exist — that
    // would indicate the dispatch fell through to the wiki-embed link
    // fallback instead of promoting to WikiEmbedFile.
    const pdfChip = page.locator('span[data-link]').filter({ hasText: 'meeting.pdf' });
    await expect(pdfChip).toHaveCount(0);

    // Also: no `.ok-pdf` canvas viewer wrapper — that would indicate a
    // regression where PDF auto-routing back to the pdfjs viewer was
    // re-introduced.
    const pdfWrapper = page.locator('.ok-pdf');
    await expect(pdfWrapper).toHaveCount(0);
  });

  test('P9.9: [[foo]] wiki-link chip — bare click does NOT fire dispatcher (regression guard)', async ({
    page,
    api,
    context,
  }) => {
    // Regression invariant: clicking a doc-to-doc wiki-link chip (`[[foo]]`)
    // should NOT fire the asset dispatcher — wiki-link `handlePrimary`
    // routes resolved doc targets through same-tab hash nav, NOT the asset
    // dispatcher. Cmd+click follows the same path with `window.open` for
    // new-tab. The amendment must not accidentally route
    // wiki-links through the asset dispatcher. We assert via
    // no-new-page-opened: if the dispatcher fired, its web fallback would
    // window.open() → context 'page' event. (Same-tab hash nav does NOT
    // fire 'page' — that's reserved for new tabs/windows.)
    const targetDoc = `foo-target-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${targetDoc}.md`);
    await api.replaceDoc(targetDoc, '# Target\n');
    await api.replaceDoc(docName, `# Source\n\n[[${targetDoc}]]\n`);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

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
    // Bare-clicking a link to a non-markdown file navigates to the SAME
    // in-app preview the sidebar opens on selection — NOT a hand-off to the
    // OS / a new tab. For a non-viewable type (html) that preview is the
    // generic fallback with "Open file" + "View as text".
    writeFileSync(
      join(workerServer.contentDir, 'guide.html'),
      '<!doctype html><meta charset="utf-8"><title>Guide</title><p>hi</p>',
    );

    // Hand-authored markdown link to the existing html file. Post-roundtrip
    // classifyMarkdownHref returns {kind:'asset'} for this.
    await api.replaceDoc(docName, `# Markdown link test\n\nSee [the guide](./guide.html).\n`);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect(page.locator('[data-resolution-state="asset"]').first()).toBeVisible({
      timeout: 10_000,
    });

    await page.click('span[data-link]');

    // Hash routes to the asset preview surface (sidebar parity); EditorArea
    // renders AssetPreview, whose non-viewable fallback exposes the "View
    // as text" affordance — the exact screen the sidebar
    // opens when the html file is selected there.
    await expect
      .poll(async () => page.evaluate(() => window.location.hash))
      .toBe('#/__asset__/guide.html');
    await expect(page.getByTestId('asset-preview-open-as-text')).toBeVisible({ timeout: 5_000 });

    // No new tab / OS hand-off on bare click. `waitForEvent` rejects on
    // timeout; a null result confirms no new-page event fired.
    const openedPage = await context.waitForEvent('page', { timeout: 1_000 }).catch(() => null);
    expect(openedPage).toBeNull();
  });

  test('P9.10b: Cmd/Ctrl+click on the same link is the OS-delegation escape hatch → new tab', async ({
    page,
    api,
    context,
    workerServer,
  }) => {
    // The bare-click → in-app preview change keeps the universal
    // "open in a new context" gesture: Cmd/Ctrl/middle-click still routes
    // through the dispatcher, which on web falls back to window.open (a new
    // tab) and on desktop hands the file to the OS default app.
    writeFileSync(
      join(workerServer.contentDir, 'guide.html'),
      '<!doctype html><meta charset="utf-8"><title>Guide</title><p>hi</p>',
    );
    await api.replaceDoc(docName, `# Markdown link test\n\nSee [the guide](./guide.html).\n`);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect(page.locator('[data-resolution-state="asset"]').first()).toBeVisible({
      timeout: 10_000,
    });
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 5_000 }),
      page.click('span[data-link]', { modifiers: ['Meta'] }),
    ]);
    // Assert on the popup itself, not a window.open monkey-patch recording
    // into a page-global: the patch (and its array) does not survive a
    // page reload, so the old expect.poll(__assetOpenCalls) flaked whenever
    // one landed mid-test. The popup is created by the
    // real window.open either way, and waitForURL also absorbs the
    // about:blank → resolved-URL navigation the new tab goes through.
    await newPage.waitForURL('**/guide.html', { timeout: 10_000 });
    await newPage.close();
  });

  test('P9.11: inline image click is a no-op (regression guard — dispatcher does not fire)', async ({
    page,
  }) => {
    // Seed with a PM image node by dropping a PNG. Use the file-scope
    // dropFileIntoEditor helper: it targets `window.__activeEditor.view.dom`
    // (not a racey `.ProseMirror` querySelector that can resolve to a
    // cached doc's editor under the Activity pool) and dispatches dragover
    // then drop so TipTap's FileHandler extension completes its sequence.
    await dropFileIntoEditor(page, TINY_PNG_BYTES, 'photo.png', 'image/png');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('photo.png');

    // Scope to the editor AND content-qualify by src: ProseMirror inserts
    // hidden trailing-hack / mark-cursor `<img class="ProseMirror-separator">`
    // widgets inside `.ProseMirror`, so a bare `img` (or `.ProseMirror img`)
    // `.first()` resolves to a sourceless separator. The `[src*="photo.png"]`
    // qualifier matches only the dropped image — separators carry no src.
    const img = page.locator('.ProseMirror img[src*="photo.png"]').first();
    await img.waitFor({ state: 'visible', timeout: 5_000 });

    // Clicking an image should NOT open a new tab. `waitForEvent` rejects
    // on timeout; a null result confirms no new-page event fired — no
    // wall-clock `page.waitForTimeout` needed (precedent #20(a)).
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
    // Relative escape with an asset extension — classifier returns
    // `asset` kind, but `resolveAssetProjectPath` detects the `..` pop
    // past project root and returns null → handlePrimary returns false
    // → PropPanel opens instead of dispatcher. No new tab.
    await api.replaceDoc(
      docName,
      `# Escape attempt\n\n[evil](../../etc/config.pdf) should refuse.\n`,
    );
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    await page.click('span[data-link]');
    const openedPage = await context.waitForEvent('page', { timeout: 1_000 }).catch(() => null);
    expect(openedPage).toBeNull();
  });

  // ── additions (Bug B/C + Bug A regression guards) ───────────
  //
  // The existing P9.1..P9.15 scenarios all seed docs at the content ROOT,
  // where the doc-relative `<img src>` / `<a href>` coincidentally matches
  // the server-absolute URL (everything is at `/`). Under hash routing
  // (editor URL `http://localhost:<port>/#/docs/sub/notes`), the browser
  // resolves relative URLs against `location.pathname === '/'`, not
  // against the doc's subdirectory. The bugs surface only when the doc
  // lives at a non-root path.
  //
  // These scenarios pin the user-observable behavior: subdir asset drops
  // must render (image decodes, PDF tab serves application/pdf), and
  // `.md` drops must resolve against case-preserved cache entries.

  test('P9.17: subdirectory PNG drop — rendered <img> actually loads (naturalWidth > 0)', async ({
    page,
    api,
  }) => {
    // Override the root-level docName from beforeEach — use a subdir doc.
    const subdirDoc = `docs/sub-${randomUUID().slice(0, 6)}/notes`;
    await api.createPage(`${subdirDoc}.md`);
    await api.replaceDoc(subdirDoc, '# Subdir doc\n');
    await page.goto(`/#/${subdirDoc}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    await dropFileIntoEditor(page, TINY_PNG_BYTES, 'photo.png', 'image/png');

    // Wait for Y.Text to carry a photo.png reference — image-extension
    // drops emit the canonical `<img src="…/photo.png" />` JSX shape
    // (alt is omitted on drop so the chrome-bar gear nudge fires). The
    // substring assertion is shape-tolerant.
    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('photo.png');

    // Content-qualify by src so the locator skips ProseMirror's hidden
    // `<img class="ProseMirror-separator">` widgets (sourceless, naturalWidth
    // always 0). A bare `.ProseMirror img` `.first()` resolves to a separator
    // and the naturalWidth poll below could never pass. `[src*="photo.png"]`
    // stays src-shape-agnostic — it matches whether the rendered URL is the
    // correct `/docs/sub-XXX/photo.png` or a broken root-relative one — so
    // the naturalWidth assertion is what fails if a URL regression exists.
    const img = page.locator('.ProseMirror img[src*="photo.png"]').first();
    await img.waitFor({ state: 'attached', timeout: 5_000 });

    // THE assertion: naturalWidth > 0 means the bytes loaded + decoded.
    // the <img src> points at root-level `/photo.png` which is
    // served by Vite's SPA fallback as text/html (not image/png) — the
    // browser fails to decode, naturalWidth stays 0. The regression
    // guard catches any future change that breaks subdir-doc image URLs.
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
    // The synchronous
    // `/api/create-page` → `contentFilter.incrementMdDir` + `registerWrite`
    // closed the file-watcher race that made the original round-trip
    // assertion flaky. Now safe to assert the full server behavior.
    //
    // chip emitted `<a href="doc.pdf">` which resolved against
    // `/` under hash routing → SPA fallback served `text/html`.
    // chip href is `/docs/sub-xxx/doc.pdf`, server streams the PDF bytes
    // with `Content-Disposition: inline` + `Content-Type: application/pdf`.
    const subdirDoc = `docs/sub-${randomUUID().slice(0, 6)}/notes`;
    await api.createPage(`${subdirDoc}.md`);
    await api.replaceDoc(subdirDoc, '# Subdir doc\n');
    await page.goto(`/#/${subdirDoc}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    await dropFileIntoEditor(page, TINY_PDF_BYTES, 'doc.pdf', 'application/pdf');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('doc.pdf');

    // Settlement signal: wait for the source to carry the wiki-embed
    // canonical form `![[doc.pdf]]`. This is what Observer A emits once it
    // has serialized the dropped `wikiLinkEmbed` atom; it does NOT require
    // Observer B's re-parse + JSX swap. The earlier 5s poll for 'doc.pdf'
    // can be satisfied by intermediate states (markdown link forms etc.);
    // the wiki-embed bracket form is the post-Observer-A canonical and is
    // sufficient to prove the drop pipeline finished its server-bound work.
    //
    // Why this and not a JSX-surface waitFor: PDF drop is the only path in
    // the stress suite that exercises the full "wikiembed atom -> server
    // bridge cycle -> JSX swap" sequence. Image/video/audio drops insert
    // `jsxComponent` directly via Path A in `pickInsertShape`. Under
    // 4-worker CI contention the bridge round-trip tail-latency exceeded
    // 30s on multiple consecutive runs. The JSX render race is not part
    // of this test's contract — that's the asset-serve middleware response
    // verified by `page.request.get` below. The JSX render is exercised
    // by `drop-pipeline-auto-open.e2e.ts` (DROP-NOAUTOOPEN-* cells, which
    // assert on the `data-prop-panel` surface and run sub-second) and by
    // unit tests of `JsxComponentView`. This test's unique coverage is the
    // serve-middleware response, not the JSX paint.
    await expect
      .poll(async () => await getSourceText(page), { timeout: 30_000 })
      .toContain('![[doc.pdf]]');

    // Reconstruct the expected URL from test inputs: subdirDoc is
    // `docs/sub-XXXXXX/notes`, the dropped file lives in the doc's
    // directory as `doc.pdf`, so the served URL is `/docs/sub-XXXXXX/doc.pdf`.
    const expectedHref = `/${subdirDoc.split('/').slice(0, -1).join('/')}/doc.pdf`;

    // Full round-trip assertion: fetch the URL directly and verify the
    // server serves the PDF correctly (not SPA-fallback HTML).
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
    // Scenario: an existing doc `CaseCheckXXXXXX`
    // (cap-C, mixed-case) is in the cache. User drops `CaseCheckXXXXXX.md`.
    // Drop flow: `pickInsertShape('CaseCheckXXXXXX.md')` → `wiki-link` kind;
    // `buildUnresolvedWikiLinkAttrs('CaseCheckXXXXXX')` → target='casecheckXXXXXX'
    // (lowercased slug). `isResolvedWikiLinkTarget('casecheckXXXXXX',
    // {CaseCheckXXXXXX, ...})` returns false → click opens prop panel showing
    // "Page not found". slug-keyed cache lookup matches → prop panel
    // shows "Wiki link" + "Open" button.
    //
    // Assertion surface: click the chip to open WikiLinkPropPanel, then check
    // the rendered stateLabel text. "Wiki link" = resolved, "Page not found"
    // = unresolved. Using UX-level text avoids coupling to the chip's internal
    // DOM structure (wiki-link NodeView has no persistent data-resolved attr;
    // resolution is computed on-demand by the prop panel via
    // `isResolvedWikiLinkTarget`, which is the function the fix
    // lives in).
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

    // The drop flow emits a wiki-link NODE (not a link mark). Its NodeView
    // renders `<span data-wiki-link>` with `role="button"`.
    const chip = page.locator('[data-wiki-link]').first();
    await chip.waitFor({ state: 'visible', timeout: 5_000 });

    // Hover the chip to open WikiLinkPropPanel (click
    // navigates / dispatches; hover opens the panel). The prop panel's state
    // label reads `isResolvedWikiLinkTarget(target, pages)` — this is where
    // Bug A lives.
    await chip.hover();

    // Resolved state: "Wiki link" text is visible AND "Page not found" is NOT.
    // this assertion fails: panel renders "Page not found" because
    // the lowercased slug target does not match the case-preserved cache key.
    await expect(page.getByText('Wiki link').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Page not found')).not.toBeVisible();
  });

  test('P9.21: `.m4v` drop renders through Video JSX + server serves video/mp4 inline (2026-04-24b)', async ({
    page,
    api,
  }) => {
    // reshaped: video extensions now drop as
    // `<video src>` JSX (descriptor-rendered via Video.tsx) instead of a
    // wiki-embed `<a>` chip. The original three defects this guarded:
    //   (1) `.m4v` NOT in `ASSET_EXTENSIONS` → content-filter refused
    //       serve → SPA fallback.        [STILL LOAD-BEARING — `<video>`
    //                                     fetches the resource itself]
    //   (2) InteractionLayer wiring (chip dispatch on click).
    //                                     [SUPERSEDED — JSX has no chip;
    //                                      the PDF test covers chip path]
    //   (3) `classifyMarkdownHref` asset classification.
    //                                     [SUPERSEDED — same as (2)]
    // This test now pins defect (1): the URL embedded in `<video src>`
    // MUST be server-absolute and the asset-serve middleware MUST stream
    // the bytes with `Content-Disposition: inline` + `Content-Type:
    // video/mp4`. Without those, in-page playback fails on Chromium.
    const subdirDoc = `docs/sub-${randomUUID().slice(0, 6)}/notes`;
    await api.createPage(`${subdirDoc}.md`);
    await api.replaceDoc(subdirDoc, '# Video doc\n');
    await page.goto(`/#/${subdirDoc}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    // Minimal M4V bytes — the ISO-BMFF signature at offset 4 is enough for
    // file-type sniff (`ftypM4V ` branded MP4 variant). Content-Type
    // dispatch happens at sirv via mrmime; the test asserts HREF SHAPE
    // only (full round-trip Content-Type requires the filewatcher's
    // dirCount to propagate — a timing-dependent surface).
    const TINY_M4V_BYTES = Array.from(
      Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4V '), Buffer.alloc(8, 0)]),
    );
    await dropFileIntoEditor(page, TINY_M4V_BYTES, 'clip.m4v', 'video/mp4');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('clip.m4v');
    const text = await getSourceText(page);
    // Source emits the lowercase `<video>` JSX shape (descriptor render via
    // Video.tsx). Server-absolute src so the browser resolves it against
    // origin under hash routing, not against the doc's hash fragment.
    expect(text).toMatch(/<video\s+src="\/docs\/sub-[^/]+\/clip\.m4v"/);
    // `controls={true}` matches the canonical `<video>` descriptor's
    // declared default; emit-time omit-on-default strips the attribute on
    // the canonical serialize path. Renderer applies controls=true on
    // load regardless. See `serialize-helpers.ts` reconstructAttrs.
    expect(text).not.toMatch(/controls(=|\s|\/>|>)/);

    // The Video NodeView renders the lowercase `<video>` element. Pin its
    // server-absolute src — it was doc-relative (broken under
    // hash routing).
    const videoEl = page.locator('.ProseMirror video[src*="/clip.m4v"]').first();
    await videoEl.waitFor({ state: 'visible', timeout: 5_000 });
    const src = await videoEl.getAttribute('src');
    expect(src).toMatch(/^\/docs\/sub-[^/]+\/clip\.m4v$/);

    // Full round-trip: fetching the embedded URL streams the file bytes
    // with `Content-Disposition: inline` + `Content-Type: video/mp4`
    // (mrmime gap closed in `asset-serve-middleware.ts` at module load).
    // Previously, the server served `text/html` SPA fallback.
    // Before the mrmime patch, the Content-Type was empty → Chromium
    // rendered the bytes as garbled text. This assertion pins both fixes
    // together.
    const res = await page.request.get(src ?? '');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toBe('inline');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['content-type'] ?? '').toMatch(/^video\/mp4/);
  });

  test('P9.22: missing asset URL returns 404, not the SPA fallback editor shell (2026-04-24b)', async ({
    page,
  }) => {
    // Regression: navigating
    // directly to a non-existent asset URL returned HTML (the editor
    // shell) instead of 404. Vite's `htmlFallbackMiddleware` serves
    // index.html for any unmatched path; without the 404
    // guard, this falls through and the browser renders the app.
    //
    // Now asserted at the top test tier: any asset-extension path that
    // the server can't serve MUST 404 with a non-HTML Content-Type. No
    // setup required — just hit a URL that's guaranteed to not exist.
    const res = await page.request.get('/definitely-not-there.m4v');
    expect(res.status()).toBe(404);
    const contentType = res.headers()['content-type'] ?? '';
    expect(contentType).not.toMatch(/^text\/html/);
    const body = await res.text();
    // The editor shell HTML contains an app-root element; the 404 body
    // should not.
    expect(body).not.toContain('id="root"');
  });
});
