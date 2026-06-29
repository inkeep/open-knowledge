import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

interface ApiSeed {
  seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void>;
}

async function setupDoc(page: Page, api: ApiSeed, markdown: string): Promise<string> {
  const docName = `halo-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return docName;
}

async function nodeSelectFirstJsx(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    editor.chain().focus().setNodeSelection(pos).run();
  }, componentName);
}

/** Drift PM selection into the first matching jsxComponent's body — a
 *  TextSelection with $from inside the wrapper's content hole. */
async function driftSelectionIntoFirstJsxBody(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    editor
      .chain()
      .setTextSelection(pos + 2)
      .run();
  }, componentName);
}

async function selectionType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    return editor.state.selection.constructor.name;
  });
}

/** Double-rAF flush so FR16's rAF-scheduled `setNodeSelection` + TipTap's
 *  own rAF-debounced `handleSelectionUpdate` (which flips the `selected`
 *  NodeView prop via React `updateProps`) both complete before the test
 *  reads DOM. */
async function flushRaf(page: Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

test('AC24: TextSelection inside a Callout body leaves data-selected unset and ::after opacity = 0', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  await driftSelectionIntoFirstJsxBody(page, 'Callout');
  expect(await selectionType(page)).toBe('TextSelection');

  expect(await callout.getAttribute('data-selected')).toBeNull();
  const opacityStr = await callout.evaluate((el) => window.getComputedStyle(el, '::after').opacity);
  expect(Number.parseFloat(opacityStr)).toBe(0);
});

test('AC25: grip-click on a Callout sets data-selected=true and the halo paints (opacity > 0)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });
  await callout.hover();

  const grip = page.locator('.ok-drag-grip').first();
  await expect(grip).toBeVisible({ timeout: 5_000 });
  await grip.click();

  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });
  expect(await selectionType(page)).toBe('NodeSelection');
  const opacityStr = await callout.evaluate((el) => window.getComputedStyle(el, '::after').opacity);
  expect(Number.parseFloat(opacityStr)).toBeGreaterThan(0);
});

test('AC26 forward: nested Callout>Accordion, NodeSelect inner Accordion → outer Callout has data-has-child-selected and not data-selected', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n\n<Accordion title="Inner">\n\nbody\n\n</Accordion>\n\n</Callout>\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await nodeSelectFirstJsx(page, 'Accordion');
  const innerAccordion = page
    .locator('.jsx-component-wrapper[data-component-type="accordion"]')
    .first();
  const outerCallout = page
    .locator('.jsx-component-wrapper[data-component-type="callout"]')
    .first();

  await expect(innerAccordion).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(outerCallout).toHaveAttribute('data-has-child-selected', 'true');
  expect(await outerCallout.getAttribute('data-selected')).toBeNull();
  expect(await innerAccordion.getAttribute('data-has-child-selected')).toBeNull();
});

test('AC26 inverse: TextSelection inside Callout body — chain-leaf Callout has no data-has-child-selected', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  await driftSelectionIntoFirstJsxBody(page, 'Callout');
  expect(await selectionType(page)).toBe('TextSelection');

  expect(await callout.getAttribute('data-selected')).toBeNull();
  expect(await callout.getAttribute('data-has-child-selected')).toBeNull();
});

test('AC27: SelectionAnnouncer aria-live updates through TextSelection-inside → outside → NodeSelection-on transitions', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter paragraph\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });
  const liveRegion = page.locator('[role="status"][aria-live="polite"]');

  await driftSelectionIntoFirstJsxBody(page, 'Callout');
  await expect(liveRegion).toContainText('Selected: Callout', { timeout: 2_000 });

  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().setTextSelection(editor.state.doc.content.size).run();
  });
  await expect(liveRegion).toContainText('Outside any block', { timeout: 2_000 });

  await callout.hover();
  const grip = page.locator('.ok-drag-grip').first();
  await expect(grip).toBeVisible({ timeout: 5_000 });
  await grip.click();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });
  await expect(liveRegion).toContainText('Selected: Callout', { timeout: 2_000 });
});

test('AC30: NodeSelect → gear → drift → Esc — halo re-paints after FR16 rAF restore', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  await callout.hover();
  const grip = page.locator('.ok-drag-grip').first();
  await expect(grip).toBeVisible({ timeout: 5_000 });
  await grip.click();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });

  const gear = callout.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  await driftSelectionIntoFirstJsxBody(page, 'Callout');
  expect(await selectionType(page)).toBe('TextSelection');
  await expect.poll(() => callout.getAttribute('data-selected'), { timeout: 2_000 }).toBeNull();

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });
  await flushRaf(page);

  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });
  const opacityStr = await callout.evaluate((el) => window.getComputedStyle(el, '::after').opacity);
  expect(Number.parseFloat(opacityStr)).toBeGreaterThan(0);
});

test('AC31: range covering exactly one Callout paints background (soft), not border-color (full)', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    'before paragraph\n\n<Callout type="note">\n\nbody\n\n</Callout>\n\nafter paragraph\n',
  );
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    let size = 0;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === 'Callout') {
        pos = p;
        size = node.nodeSize;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error('Callout not found');
    const from = Math.max(0, pos - 1);
    const to = Math.min(editor.state.doc.content.size, pos + size + 1);
    editor.chain().focus().setTextSelection({ from, to }).run();
  });

  await expect(callout).toHaveAttribute('data-range-selected', 'true', { timeout: 2_000 });
  expect(await callout.getAttribute('data-selected')).toBeNull();

  const halo = await callout.evaluate((el) => {
    const cs = window.getComputedStyle(el, '::after');
    return {
      background: cs.background,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
    };
  });
  expect(halo.backgroundColor).not.toMatch(/rgba?\(0,\s*0,\s*0,\s*0\)|^transparent\b/);
  expect(halo.borderColor).toMatch(/rgba?\(0,\s*0,\s*0,\s*0\)|^transparent\b/);
});
