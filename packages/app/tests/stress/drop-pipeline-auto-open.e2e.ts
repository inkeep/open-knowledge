/**
 * Drop-pipeline auto-open negative contract — the symmetric counterpart to
 * `slash-command-auto-open.e2e.ts`.
 *
 * The drop-vs-slash boundary is principled: a drop is a passive event where
 * the user already supplied the asset; a slash insertion is a deliberate
 * request to insert and configure. The drop pipeline must therefore preserve
 * NodeSelection (so the chrome bar appears) but NOT trigger the auto-open
 * useEffect in `JsxComponentView`.
 *
 * The contract this file pins, separately and directly: dropping a media
 * file does not open the descriptor PropPanel. P9.11 in `asset-click-
 * dispatch.e2e.ts` catches today's specific regression as a side effect
 * (the popover overlapping the image makes Playwright's actionability check
 * reject the click), but P9.11's invariant is "click is a no-op for the
 * dispatcher" — not "no popover opens." A future regression that re-adds
 * auto-open on drop with the popover positioned away from the image
 * (e.g., above the editor) would silently pass P9.11 while breaking the
 * drop-is-passive contract. This file's tests would fail in that scenario.
 *
 * Coverage spans image, video, and audio drops because all three traverse
 * the shared `image-upload/index.ts` drop path in `uploadAndInsert` and a
 * future per-media-type refactor must explicitly preserve the contract for
 * each type.
 *
 * The positive counterpart (slash-command insertion DOES auto-open) lives
 * in `slash-command-auto-open.e2e.ts`.
 */

import type { Page } from '@playwright/test';
import {
  createMp3Buffer,
  createMp4Buffer,
  createPngBuffer,
  expect,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROP_PANEL_TIMEOUT = 1_500;

/**
 * Mirrors `dropFileIntoEditor` in `asset-click-dispatch.e2e.ts`. Synthesizing
 * a `dragover` immediately followed by a `drop` so TipTap's FileHandler
 * extension completes its event sequence the same way a browser-native
 * drag-and-drop does.
 */
async function dropFileIntoEditor(
  page: Page,
  bytes: number[],
  filename: string,
  mime: string,
): Promise<void> {
  await page.evaluate(
    ({ bytes: byteArr, filename: fn, mime: mt }) => {
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

async function getSourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Three cells, one per media type the drop pipeline accepts. The path inside
// `image-upload/index.ts` is shared across types today; cells stay separate
// so a per-type refactor is forced to keep the contract intact for each.

// Per-test-file salt on the magic-byte fixtures so the server's same-dir
// sha256 dedup (`findDuplicateAsset` in `api-extension.ts`) cannot collapse
// our drops onto a byte-identical upload from a sister stress file sharing
// the worker's contentDir. Without salts, asset-embed.e2e.ts's TINY_PNG
// bytes (same base64) land first and our `photo.png` drop returns a deduped
// `shot.png` src — failing the `sourceMarker` assertion below. The salt
// only appends bytes after the format-defining magic header, so the file
// still type-sniffs as the intended format. Bug shape characterized in
// `upload-fixtures.ts` docstring.
const cases = [
  {
    name: 'png-image',
    label: 'image/png',
    filename: 'photo.png',
    mime: 'image/png',
    bytes: () => Array.from(createPngBuffer('drop-noautoopen-png')),
    sourceMarker: /photo(?:-\d+)?\.png/,
  },
  {
    name: 'mp4-video',
    label: 'video/mp4',
    filename: 'clip.mp4',
    mime: 'video/mp4',
    bytes: () => Array.from(createMp4Buffer('drop-noautoopen-mp4')),
    sourceMarker: /clip(?:-\d+)?\.mp4/,
  },
  {
    name: 'mp3-audio',
    label: 'audio/mpeg',
    filename: 'sound.mp3',
    mime: 'audio/mpeg',
    bytes: () => Array.from(createMp3Buffer('drop-noautoopen-mp3')),
    sourceMarker: /sound(?:-\d+)?\.mp3/,
  },
] as const;

test.describe('Drop pipeline does not auto-open the descriptor PropPanel', () => {
  for (const c of cases) {
    test(`DROP-NOAUTOOPEN-${c.name.toUpperCase()}: dropped ${c.label} is selected, popover stays closed`, async ({
      page,
      api,
    }) => {
      const docName = `drop-noautoopen-${c.name}-${Math.random().toString(36).slice(2, 10)}`;
      await api.createPage(`${docName}.md`);
      await page.goto(`/#/${docName}`);
      await waitForProvider(page);
      await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
      await page.click('.ProseMirror:not(.composer-prosemirror)');

      await dropFileIntoEditor(page, c.bytes(), c.filename, c.mime);

      // The drop completes when the source carries a reference to the file.
      // Y.XmlFragment → Y.Text Observer A serializes the inserted node; once
      // the marker text is visible, the drop pipeline (including the
      // setNodeSelection call site in image-upload/index.ts uploadAndInsert)
      // has executed.
      await expect
        .poll(async () => await getSourceText(page), { timeout: 5_000 })
        .toMatch(c.sourceMarker);

      // THE assertion: PropPanel does NOT auto-open. `[data-prop-panel]` is
      // only rendered when the descriptor's Popover open state is true,
      // which JsxComponentView's auto-open useEffect toggles via
      // `consumeAutoOpen(pos)`. The drop call site in image-upload/index.ts
      // (setNodeSelection after insertContentAt) must NOT push the inserted
      // position into `pendingAutoOpen` — `setNodeSelection` alone preserves
      // selection without triggering the open. If a future change re-adds
      // `focusInsertedComponent` to the drop path, this locator becomes
      // visible and the test fails.
      await expect(page.locator('[data-prop-panel]')).toBeHidden({
        timeout: PROP_PANEL_TIMEOUT,
      });
    });
  }
});
