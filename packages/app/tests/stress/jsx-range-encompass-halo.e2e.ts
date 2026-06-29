import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

interface ApiSeed {
  seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void>;
}

async function setupDoc(page: Page, api: ApiSeed, markdown: string): Promise<string> {
  const docName = `range-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return docName;
}

/** Dispatch a TextSelection from doc-start to doc-end. AllSelection-shaped
 *  selection produced by TipTap's `selectAll()` command — equivalent to
 *  the user pressing Cmd+A. Exercises the range-encompass derivation
 *  deterministically (avoids coordinate-based drag-select, which fights
 *  Playwright's actionability gates over the `contentEditable=false`
 *  wrapper chrome). */
async function selectAllText(page: Page) {
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().selectAll().run();
  });
}

/** Programmatically NodeSelect the first jsxComponent matching `componentName`.
 *  Used to drive AC13's "full halo" state without depending on hover-then-grip
 *  mouse coordination. */
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

/** Dispatch a TextSelection that fully covers the first jsxComponent matching
 *  `componentName`. Selection extends from just before the wrapper's open to
 *  just after its nodeSize — the minimum range that satisfies the
 *  `pos >= from && pos + nodeSize <= to` containment rule used by
 *  `deriveRangeEncompassedBlockIds`. Routed through TipTap's
 *  `setTextSelection` command rather than reaching into PM's `TextSelection`
 *  constructor — keeps the test free of cross-context imports. */
async function selectRangeOverFirstJsx(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    let size = 0;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        size = node.nodeSize;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    const from = Math.max(0, pos - 1);
    const to = Math.min(editor.state.doc.content.size, pos + size + 1);
    editor.chain().focus().setTextSelection({ from, to }).run();
  }, componentName);
}

test('AC11: TextSelection range covering one Callout sets data-range-selected with opacity>0', async ({
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

  expect(await callout.getAttribute('data-range-selected')).toBeNull();

  await selectRangeOverFirstJsx(page, 'Callout');

  await expect(callout).toHaveAttribute('data-range-selected', 'true', { timeout: 2_000 });
  expect(await callout.getAttribute('data-selected')).toBeNull();

  await expect
    .poll(
      () =>
        callout.evaluate((el) => Number.parseFloat(window.getComputedStyle(el, '::after').opacity)),
      { timeout: 2_000 },
    )
    .toBeGreaterThan(0);
});

test('AC12: Cmd+A populates data-range-selected on every JSX wrapper in the doc', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    'first\n\n<Callout type="note">\n\nbody\n\n</Callout>\n\nmiddle\n\n<Accordion title="A">\n\nbody\n\n</Accordion>\n\nlast\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await expect(page.locator('.jsx-component-wrapper[data-range-selected="true"]')).toHaveCount(0);

  await selectAllText(page);

  await expect(page.locator('.jsx-component-wrapper[data-range-selected="true"]')).toHaveCount(2);
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  const accordion = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await expect(callout).toHaveAttribute('data-range-selected', 'true');
  await expect(accordion).toHaveAttribute('data-range-selected', 'true');
  expect(await callout.getAttribute('data-selected')).toBeNull();
  expect(await accordion.getAttribute('data-selected')).toBeNull();
});

test('AC13: soft range halo paints a distinct background from the full ring halo', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  await nodeSelectFirstJsx(page, 'Callout');
  await expect(callout).toHaveAttribute('data-selected', 'true');
  await expect
    .poll(
      () =>
        callout.evaluate((el) => Number.parseFloat(window.getComputedStyle(el, '::after').opacity)),
      { timeout: 2_000 },
    )
    .toBeGreaterThan(0);
  const fullHalo = await callout.evaluate((el) => {
    const cs = window.getComputedStyle(el, '::after');
    return {
      background: cs.background,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      opacity: cs.opacity,
    };
  });

  await selectAllText(page);
  await expect(callout).toHaveAttribute('data-range-selected', 'true', { timeout: 2_000 });
  expect(await callout.getAttribute('data-selected')).toBeNull();
  const softHalo = await callout.evaluate((el) => {
    const cs = window.getComputedStyle(el, '::after');
    return {
      background: cs.background,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      opacity: cs.opacity,
    };
  });

  expect(softHalo.backgroundColor).not.toBe(fullHalo.backgroundColor);
  expect(softHalo.borderColor).not.toBe(fullHalo.borderColor);
  expect(softHalo.backgroundColor).not.toMatch(/rgba?\(0,\s*0,\s*0,\s*0\)|^transparent\b/);
  expect(Number.parseFloat(fullHalo.opacity)).toBeGreaterThan(0);
  expect(Number.parseFloat(softHalo.opacity)).toBeGreaterThan(0);
});
