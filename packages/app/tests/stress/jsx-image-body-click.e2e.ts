/**
 * Image body-click verification pin.
 *
 * Pins the current behavior of the existing `handleBodyClick` path in
 * `JsxComponentView.tsx` against a real-loaded image. The verification
 * documented an existing limitation: clicking the rendered `<img>`
 * dispatches `react-medium-image-zoom`'s lightbox (the canonical image
 * component wraps `BareImg` in `<Zoom>`), so the click never reaches PM's
 * mousedown-on-leaf path. `handleBodyClick`'s "selection still inside
 * the node" guard (`selFrom < pos || selFrom >= nodeEnd`) then returns
 * early because PM's selection never moved into the img range. Net
 * result: clicking the image does NOT NodeSelect via this path; users
 * reach NodeSelection via grip-click (covered by
 * `grip-click-nodeselect.e2e.ts`), keyboard L1/L2 nav, or programmatic
 * APIs.
 *
 * The fix is not included here because it is large: it would require
 * coordinating Zoom + PM selection or reshaping the click semantics.
 *
 * This test PINS the current behavior. If it ever starts failing (img
 * body-click DOES NodeSelect), the limitation resolved — update the
 * test to assert NodeSelection.
 *
 * Real Chromium is required: `react-medium-image-zoom` interaction,
 * floating-ui chrome rendering, and the PM mousedown pipeline are not
 * faithful in happy-dom / jsdom.
 *
 * Excluded from CI's fixed `test:e2e` subset; runs under
 * `bunx playwright test` for pre-push coverage (mirrors
 * grip-click-nodeselect.e2e.ts policy).
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

interface ApiSeed {
  seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void>;
}

async function setupDoc(page: Page, api: ApiSeed, markdown: string): Promise<string> {
  const docName = `imgclick-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return docName;
}

test('AC21/F4: img body-click does NOT NodeSelect (Zoom interception pin)', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '<img src="https://picsum.photos/id/237/300/200" alt="real loaded asset" />\n\nafter\n',
  );

  // Park the cursor at the trailing paragraph (a position outside the img
  // range) so the post-click selection is observably distinct from "PM
  // happened to put the cursor on the img already."
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().setTextSelection(editor.state.doc.content.size).run();
  });

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await wrapper.waitFor({ state: 'visible', timeout: 5_000 });

  const img = wrapper.locator('img').first();
  await img.waitFor({ state: 'visible', timeout: 5_000 });
  await img.click();

  // Pin: PM stays in TextSelection — Zoom intercepted the click. If this
  // ever flips, the limitation resolved and the assertion needs to flip with it.
  const selType = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return 'no-editor';
    return editor.state.selection.constructor.name;
  });
  expect(selType).toBe('TextSelection');
  await expect(wrapper).not.toHaveAttribute('data-selected', 'true');
});
