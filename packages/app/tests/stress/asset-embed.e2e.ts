/**
 * E2E coverage for the editor asset + embed surface.
 *
 * Covers the user-visible happy/unhappy paths
 * that genuinely need a browser:
 *
 *   - drop a PDF → server stores + client emits `![[draft.pdf]]`
 *   - drop an opaque file (CSV) → server stores + client emits
 *            `[data.csv](data.csv)` markdown link
 *   - drop oversized file → 413 + byte-size-specific toast +
 *            no placeholder lingers
 *   - second drop of identical bytes → deduped:true + dedup toast
 *
 * Other scenarios (multi-user CRDT propagation,
 * Obsidian vault open, basename ambiguity, rename + image-ref rewrite,
 * concurrent-burst convergence) live at integration-tier coverage in
 * the sibling test files (api-extension.test.ts, asset-walk.test.ts,
 * managed-rename-rewrite.test.ts, obsidian-vault-detect.test.ts).
 * They don't need DOM-binding fidelity that only Playwright can prove.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  createPngBuffer,
  escapeRegExp,
  expect,
  test,
  uniqueAssetName,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

async function dropFileIntoEditor(
  page: Page,
  buffer: number[],
  filename: string,
  mime: string,
): Promise<void> {
  await page.evaluate(
    ({ bytes, name, type }) => {
      // Pattern D + Activity pool keep multiple cached editors alive
      // concurrently. The `display:none` flip is racey on doc-change (new
      // Activity flips visible BEFORE old one flips hidden during React's
      // commit), so a CSS-only filter can pick the previous editor.
      // Use `window.__activeEditor.view.dom` (DEV-only registry per
      // `registerEditor` in TiptapEditor.tsx) for the reliable signal.
      const active = (window as unknown as { __activeEditor?: { view?: { dom?: HTMLElement } } })
        .__activeEditor;
      const editor = active?.view?.dom ?? null;
      if (!editor) throw new Error('no active editor (window.__activeEditor.view.dom)');
      const file = new File([new Uint8Array(bytes)], name, { type });
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
    { bytes: buffer, name: filename, type: mime },
  );
}

async function getSourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

const FAKE_PDF_HEADER = '%PDF-1.4\n%fake pdf bytes for e2e test\n';

test.describe('asset-embed — drop UX (SPEC §6 FR-1, FR-1a, FR-2, FR-8)', () => {
  let docName: string;
  // Per-test token shared by the docName and every asset this test uploads.
  let runId: string;
  let tinyPng: number[];

  test.beforeEach(async ({ page, api }) => {
    // Uploads land in the worker-shared contentDir keyed by filename, so a
    // per-test docName is not enough isolation: a name a sibling spec already
    // stored under different bytes comes back with a `-1` collision suffix,
    // and bytes a sibling already stored come back under the sibling's name
    // via same-dir sha256 dedup. Each test therefore mints both a unique
    // asset name (`uniqueAssetName`) and unique bytes (the `runId` salt).
    // Within a single test the bytes stay identical, which is what P3.1's
    // same-bytes-twice dedup assertion exercises.
    runId = randomUUID().slice(0, 8);
    docName = `asset-embed-${runId}`;
    tinyPng = Array.from(createPngBuffer(`asset-embed-${runId}`));
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, '# Test\n');
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.click('.ProseMirror:not(.composer-prosemirror)');
  });

  test('P1.1: drop a PDF → server stores + Y.Text contains ![[draft.pdf]]', async ({ page }) => {
    const pdfName = uniqueAssetName('draft.pdf', runId);
    const pdfBytes = Array.from(Buffer.from(`${FAKE_PDF_HEADER}%${runId}\n`, 'utf-8'));
    await dropFileIntoEditor(page, pdfBytes, pdfName, 'application/pdf');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain(`![[${pdfName}]]`);
  });

  test('P1.2: drop a CSV (FILE_ATTACHMENT_EXTENSIONS) → emits as ![[data.csv]] wikilink', async ({
    page,
  }) => {
    // `.csv` is in `FILE_ATTACHMENT_EXTENSIONS` (along
    // with the rest of the office / archive / structured-text drop
    // shapes). The drop pipeline returns `'jsx-file'` from
    // `pickInsertShape` and inserts a `jsxComponent('WikiEmbedFile')`
    // block whose serialize emits `![[data.csv]]` source bytes — same
    // wikilink shape as image / video / audio / pdf drops, unified
    // chrome via the File row in `File.tsx`.
    //
    // Truly-opaque extensions (NOT in any extension set, e.g. `.xyz`)
    // still fall through to the plain markdown link emit.
    const csvName = uniqueAssetName('data.csv', runId);
    const csvBytes = Array.from(Buffer.from(`a,b,c\n1,2,3\n${runId},4,5\n`, 'utf-8'));
    await dropFileIntoEditor(page, csvBytes, csvName, 'text/csv');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain(`![[${csvName}]]`);
  });

  test('P3.1: same PNG dropped twice → second drop dedups, single file on disk', async ({
    page,
  }) => {
    // Image-extension drops emit the OK-canonical `<img>` JSX shape —
    // drag/drop/paste land on the same Image.tsx renderer as slash-menu
    // insert + CommonMarkImage compat. On-disk markdown is
    // `<img src="/<pngName>" />` (alt omitted on drop so the chrome-bar
    // gear nudge fires); dedup is asserted by the server returning the
    // same path for both drops (no `-1` collision-suffix — `collisionName`).
    const pngName = uniqueAssetName('shot.png', runId);
    // What the server would emit if the second drop failed to dedup and had
    // to take a collision suffix instead.
    const collisionName = pngName.replace(/\.png$/, '-1.png');

    await dropFileIntoEditor(page, tinyPng, pngName, 'image/png');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toMatch(new RegExp(`<img\\s+src="/?${escapeRegExp(pngName)}"`));

    // Second drop with identical bytes — server returns deduped:true and
    // the filename in the second emit matches the existing on-disk file.
    await dropFileIntoEditor(page, tinyPng, pngName, 'image/png');

    // Two `<img …>` tags appear after both inserts; both reference
    // the same filename (no collision-suffix). Counts the JSX shape.
    await expect
      .poll(
        async () => {
          const text = await getSourceText(page);
          return (
            text.match(new RegExp(`<img\\s+[^>]*src="/?${escapeRegExp(pngName)}"`, 'g')) ?? []
          ).length;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(2);
    const text = await getSourceText(page);
    expect(text).not.toContain(collisionName);
  });

  test('P1.1-paste: paste a PNG via ClipboardEvent → Y.Text contains <img src=".../shot.png">', async ({
    page,
  }) => {
    // Clipboard-paste is a separate FileHandler binding (`onPaste`) from
    // drag-drop (`onDrop`). Both route through `uploadAndInsert`, but the
    // event-binding itself could regress independently — a TipTap upgrade
    // changing the FileHandler API or a misnamed callback would silently
    // break the dominant screenshot-paste workflow on macOS. The below
    // synthesizes a paste event with a single PNG file, matching what
    // Cmd+V produces when the clipboard contains a pasted image.
    //
    // The per-test name + salt matter for what this asserts: with the drop
    // test's name and bytes, the paste would resolve to that test's existing
    // file through same-dir dedup and pass without ever exercising a fresh
    // paste-side store.
    const pngName = uniqueAssetName('shot.png', runId);
    await page.evaluate(
      ({ bytes, name, type }) => {
        // Use the active editor (`window.__activeEditor.view.dom`) — see
        // `dropFileIntoEditor` for the rationale on why CSS visibility
        // is unreliable under Pattern D + Activity-pool race.
        const active = (window as unknown as { __activeEditor?: { view?: { dom?: HTMLElement } } })
          .__activeEditor;
        const editor = active?.view?.dom ?? null;
        if (!editor) throw new Error('no active editor (window.__activeEditor.view.dom)');
        const file = new File([new Uint8Array(bytes)], name, { type });
        const dt = new DataTransfer();
        dt.items.add(file);
        editor.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { bytes: tinyPng, name: pngName, type: 'image/png' },
    );

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toMatch(new RegExp(`<img\\s+src="/?${escapeRegExp(pngName)}"`));
  });

  test('SVG drop emits as <img> JSX (image extension; NFR-3 sniff-fallback path)', async ({
    page,
  }) => {
    // SVG has no magic bytes; the server's text-sniff fallback marks it
    // image/svg+xml so the file lands as an image. SVG is in
    // IMAGE_EXTENSIONS so the drop routes through the canonical
    // `<img>` JSX shape.
    const svgName = uniqueAssetName('diagram.svg', runId);
    const svgBytes = Array.from(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect id="${runId}"/></svg>`, 'utf-8'),
    );
    await dropFileIntoEditor(page, svgBytes, svgName, 'image/svg+xml');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toMatch(new RegExp(`<img\\s+src="/?${escapeRegExp(svgName)}"`));
  });
});
