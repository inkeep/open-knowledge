/**
 * Grip-click NodeSelect — Playwright E2E.
 *
 * Pins the observable AC bullets that require real Chromium to exercise the
 * floating-ui hover positioning and the native HTML5 click-vs-dragstart
 * platform threshold:
 *
 *   Hover any block, click the 6-dot `.ok-drag-grip` that appears.
 *          The block becomes NodeSelection target (`state.selection
 *          instanceof NodeSelection && state.selection.from === blockPos`).
 *          Repeated across paragraph, heading, Callout (composite),
 *          Accordion (composite), and img (self-closing leaf) — five
 *          representative block types.
 *
 *   Hover a block, press-drag the `.ok-drag-grip` from its position
 *          past the next block. The block order changes — proving the click
 *          handler did NOT regress the drag affordance. Native HTML5 drag
 *          and click are mutually exclusive at the platform layer: a move
 *          past the drag threshold fires `dragstart` AND suppresses the
 *          trailing `click`, so no NodeSelect happens during a real drag.
 *
 *   Sub-threshold pointer movement (2 px) followed by release
 *          fires `click` (no `dragstart` at that distance), which under
 *          "do not pre-build a drag-distance threshold"
 *          implementation produces a NodeSelection. The spec acknowledges
 *          this: "the test pins the gesture's current behavior either way."
 *          We pin the current behavior here. If a measurable false-positive
 *          rate surfaces in practice, the implementation gains a
 *          threshold and this test flips. drag invariant covers
 *          the complementary case (above-threshold motion suppresses
 *          click via the browser's native HTML5 drag mechanism).
 *
 * Real Chromium is required: floating-ui positioning, the
 * `mousedown → mousemove → dragstart-or-click` decision, and the platform
 * drag threshold are not faithful in happy-dom / jsdom.
 *
 * Excluded from CI's fixed `test:e2e` subset; runs under
 * `bunx playwright test` for pre-push coverage (mirrors
 * jsx-backspace-delete.e2e.ts policy).
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

interface ApiSeed {
  seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void>;
}

async function setupDoc(page: Page, api: ApiSeed, markdown: string): Promise<string> {
  const docName = `grip-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return docName;
}

/**
 * Hover the given target element to make the drag handle visible, then wait
 * for the handle's `visibility: hidden` inline style to lift (the
 * floating-ui plugin lifts it once it has a reference rect to position
 * against). Returns the bounding box of the visible `.ok-drag-grip`.
 */
async function hoverBlockAndGetGripBox(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const target = page.locator(selector).first();
  await target.waitFor({ state: 'visible', timeout: 5_000 });
  const box = await target.boundingBox();
  if (!box) throw new Error(`no boundingBox for ${selector}`);

  // Hover the middle of the target — DragHandlePlugin's mousemove listener
  // picks up the node under cursor and calls onNodeChange.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // The plugin lifts the inline `visibility: hidden` style once positioned.
  const grip = page.locator('.ok-drag-grip');
  await expect(grip).toBeVisible({ timeout: 5_000 });

  const gripBox = await grip.boundingBox();
  if (!gripBox) throw new Error('no boundingBox for .ok-drag-grip');
  return gripBox;
}

/** Read the PM selection's constructor name. */
async function selectionType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    return editor.state.selection.constructor.name;
  });
}

/** Read the PM selection's `from` position. */
async function selectionFrom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    return editor.state.selection.from;
  });
}

/**
 * Find the absolute PM position of the first node whose type name matches
 * `nodeTypeName`. For non-jsxComponent blocks (paragraph, heading) this
 * walks top-level doc children. For jsxComponent wrappers, match by
 * `componentName` attr.
 */
async function firstNodePos(
  page: Page,
  match: { type: 'pmType'; name: string } | { type: 'jsxComponent'; componentName: string },
): Promise<number> {
  return page.evaluate((m) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (m.type === 'pmType') {
        if (node.type.name === m.name) {
          pos = p;
          return false;
        }
      } else {
        if (
          node.type.name === 'jsxComponent' &&
          (node.attrs.componentName as string) === m.componentName
        ) {
          pos = p;
          return false;
        }
      }
      return true;
    });
    if (pos === -1) throw new Error(`node ${JSON.stringify(m)} not found`);
    return pos;
  }, match);
}

/** Set initial selection somewhere innocuous (start of doc) so a "no change"
 *  assertion has a known baseline. */
async function resetSelectionToDocStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().setTextSelection(0).run();
  });
}

// ── grip click selects every block type ───────────────────────────

test('AC22: grip click NodeSelects a paragraph', async ({ page, api }) => {
  await setupDoc(page, api, 'paragraph one\n\nparagraph two\n');
  await resetSelectionToDocStart(page);

  const gripBox = await hoverBlockAndGetGripBox(page, '.ProseMirror > p:nth-child(1)');
  await page.mouse.click(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);

  const expectedPos = await firstNodePos(page, { type: 'pmType', name: 'paragraph' });
  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
  expect(await selectionFrom(page)).toBe(expectedPos);
});

test('AC22: grip click NodeSelects a heading', async ({ page, api }) => {
  await setupDoc(page, api, '# heading one\n\nfollowing paragraph\n');
  await resetSelectionToDocStart(page);

  const gripBox = await hoverBlockAndGetGripBox(page, '.ProseMirror h1');
  await page.mouse.click(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);

  const expectedPos = await firstNodePos(page, { type: 'pmType', name: 'heading' });
  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
  expect(await selectionFrom(page)).toBe(expectedPos);
});

test('AC22: grip click NodeSelects a Callout (composite)', async ({ page, api }) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  await resetSelectionToDocStart(page);

  const gripBox = await hoverBlockAndGetGripBox(
    page,
    '.jsx-component-wrapper[data-component-type="callout"]',
  );
  await page.mouse.click(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);

  const expectedPos = await firstNodePos(page, { type: 'jsxComponent', componentName: 'Callout' });
  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
  expect(await selectionFrom(page)).toBe(expectedPos);

  // Halo paints for the JSX wrapper.
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(wrapper).toHaveAttribute('data-selected', 'true');
});

test('AC22: grip click NodeSelects an Accordion (composite)', async ({ page, api }) => {
  await setupDoc(page, api, '<Accordion title="X">\n\nbody\n\n</Accordion>\n\nafter\n');
  await resetSelectionToDocStart(page);

  const gripBox = await hoverBlockAndGetGripBox(
    page,
    '.jsx-component-wrapper[data-component-type="accordion"]',
  );
  await page.mouse.click(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);

  const expectedPos = await firstNodePos(page, {
    type: 'jsxComponent',
    componentName: 'Accordion',
  });
  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
  expect(await selectionFrom(page)).toBe(expectedPos);

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await expect(wrapper).toHaveAttribute('data-selected', 'true');
});

test('AC22: grip click NodeSelects an img (self-closing leaf)', async ({ page, api }) => {
  await setupDoc(page, api, '<img src="https://picsum.photos/200" alt="test image" />\n\nafter\n');
  await resetSelectionToDocStart(page);

  const gripBox = await hoverBlockAndGetGripBox(
    page,
    '.jsx-component-wrapper[data-component-type="img"]',
  );
  await page.mouse.click(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);

  const expectedPos = await firstNodePos(page, { type: 'jsxComponent', componentName: 'img' });
  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
  expect(await selectionFrom(page)).toBe(expectedPos);

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(wrapper).toHaveAttribute('data-selected', 'true');
});

// ── drag affordance preserved ──────────────────────────────────────

test('AC23: grip drag still moves block (drag past dragstart threshold)', async ({ page, api }) => {
  await setupDoc(page, api, 'first paragraph\n\nsecond paragraph\n\nthird paragraph\n');
  await resetSelectionToDocStart(page);

  // Initial order: first / second / third.
  const orderBefore = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return [];
    const out: string[] = [];
    editor.state.doc.forEach((node) => {
      out.push(node.textContent);
    });
    return out;
  });
  expect(orderBefore).toEqual(['first paragraph', 'second paragraph', 'third paragraph']);

  // Hover the FIRST paragraph; the drag handle anchors to it.
  const firstP = page.locator('.ProseMirror:not(.composer-prosemirror) > p').nth(0);
  const firstBox = await firstP.boundingBox();
  if (!firstBox) throw new Error('first paragraph not measurable');
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);

  const grip = page.locator('.ok-drag-grip');
  await expect(grip).toBeVisible({ timeout: 5_000 });
  const gripBox = await grip.boundingBox();
  if (!gripBox) throw new Error('grip not measurable');

  // Drop target: just below the THIRD paragraph.
  const thirdP = page.locator('.ProseMirror:not(.composer-prosemirror) > p').nth(2);
  const thirdBox = await thirdP.boundingBox();
  if (!thirdBox) throw new Error('third paragraph not measurable');

  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  // Stepwise move ensures dragstart fires reliably (mousemove past the
  // platform drag threshold). Steps=20 gives Chromium enough mousemove
  // events to commit to a drag rather than a click.
  await page.mouse.move(thirdBox.x + thirdBox.width / 2, thirdBox.y + thirdBox.height + 4, {
    steps: 20,
  });
  await page.mouse.up();

  // Block order changed — first paragraph moved past third.
  await expect
    .poll(
      async () => {
        return page.evaluate(() => {
          const editor = window.__activeEditor;
          if (!editor) return [];
          const out: string[] = [];
          editor.state.doc.forEach((node) => {
            out.push(node.textContent);
          });
          return out;
        });
      },
      { timeout: 5_000 },
    )
    .toEqual(['second paragraph', 'third paragraph', 'first paragraph']);
});

// ── micro-drag behavior (pins current implementation) ─────────────
//
// The design reads "micro-drag does NOT NodeSelect" but qualifies the
// assertion with "pins the gesture's current behavior either way."
// The implementation explicitly does NOT pre-build a drag-distance threshold.
// With no threshold, a sub-threshold pointer move (~2 px, below Chromium's
// drag threshold) fires `click` and the handler NodeSelects. We pin
// that current behavior here. If a measurable false-positive rate surfaces
// in practice, the implementation gains a threshold and this assertion
// flips (selection stays unchanged).
//
// The drag test already verifies the complement — a real drag (above-threshold
// motion across blocks) DOES suppress click via the browser's native HTML5
// drag mechanism and reorders the block instead.

test('AC29: sub-threshold pointer movement still fires click → NodeSelect (no threshold)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, 'paragraph one\n\nparagraph two\n');
  await resetSelectionToDocStart(page);

  const firstP = page.locator('.ProseMirror:not(.composer-prosemirror) > p').nth(0);
  const firstBox = await firstP.boundingBox();
  if (!firstBox) throw new Error('first paragraph not measurable');
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);

  const grip = page.locator('.ok-drag-grip');
  await expect(grip).toBeVisible({ timeout: 5_000 });
  const gripBox = await grip.boundingBox();
  if (!gripBox) throw new Error('grip not measurable');
  const startX = gripBox.x + gripBox.width / 2;
  const startY = gripBox.y + gripBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move 2 px — below Chromium's drag threshold (~4-5 px). No dragstart.
  await page.mouse.move(startX + 2, startY + 2);
  await page.mouse.up();

  const expectedPos = await firstNodePos(page, { type: 'pmType', name: 'paragraph' });
  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
  expect(await selectionFrom(page)).toBe(expectedPos);
});
