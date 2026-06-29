import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

/** Read the computed `::before` content on the FIRST empty paragraph the
 *  Placeholder extension has tagged with `.is-empty`. Returns the empty
 *  string when no such paragraph exists. */
async function placeholderContent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const p = document.querySelector('.ProseMirror p.is-empty');
    if (!p) return '__no-empty-paragraph__';
    return window.getComputedStyle(p, '::before').content;
  });
}

async function setupDocWithTrailingEmptyParagraph(
  page: Page,
  api: { seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void> },
  componentMarkdown: string,
): Promise<string> {
  const docName = `placeholder-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: `${componentMarkdown}\n\n` }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().setTextSelection(editor.state.doc.content.size).run();
  });
  return docName;
}

test('placeholder hides when Callout prop panel opens; restores on close', async ({
  page,
  api,
}) => {
  await setupDocWithTrailingEmptyParagraph(
    page,
    api,
    '<Callout type="note">\n\nbody\n\n</Callout>',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  const baseline = await placeholderContent(page);
  expect(baseline).toContain("Type '/' for commands");

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  await expect.poll(() => placeholderContent(page), { timeout: 2_000 }).toBe('none');

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });
  await expect
    .poll(() => placeholderContent(page), { timeout: 2_000 })
    .toContain("Type '/' for commands");
});

test('placeholder hides when Accordion prop panel opens; restores on close', async ({
  page,
  api,
}) => {
  await setupDocWithTrailingEmptyParagraph(
    page,
    api,
    '<Accordion title="A">\n\nbody\n\n</Accordion>',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  const baseline = await placeholderContent(page);
  expect(baseline).toContain("Type '/' for commands");

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  await expect.poll(() => placeholderContent(page), { timeout: 2_000 }).toBe('none');

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });
  await expect
    .poll(() => placeholderContent(page), { timeout: 2_000 })
    .toContain("Type '/' for commands");
});

test('placeholder still paints when a Radix popover sibling to JSX chrome is open', async ({
  page,
  api,
}) => {
  await setupDocWithTrailingEmptyParagraph(
    page,
    api,
    '<Callout type="note">\n\nbody\n\n</Callout>',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  const baseline = await placeholderContent(page);
  expect(baseline).toContain("Type '/' for commands");

  await page.evaluate(() => {
    const root = document.querySelector('.tiptap-editor');
    if (!root) throw new Error('.tiptap-editor not found');
    const btn = document.createElement('button');
    btn.setAttribute('data-slot', 'popover-trigger');
    btn.setAttribute('data-state', 'open');
    btn.textContent = 'fake-link-panel';
    root.appendChild(btn);
  });

  await expect
    .poll(() => placeholderContent(page), { timeout: 2_000 })
    .toContain("Type '/' for commands");
});
