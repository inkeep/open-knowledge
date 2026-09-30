import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';

const SEED = '<Callout type="note">\n\nbody text\n\n</Callout>\n\nafter\n';

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function open(
  page: Page,
  api: { createPage(p: string): Promise<void>; replaceDoc(d: string, m: string): Promise<void> },
): Promise<void> {
  const docName = `test-jsx-source-raw-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, SEED);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector(EDITOR);
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 10_000 });
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.textContent?.includes('body text') ?? false,
    EDITOR,
    { timeout: 10_000 },
  );
}

async function focusEditor(page: Page): Promise<void> {
  await page.locator(EDITOR).first().click();
  await page.waitForFunction(() => window.__activeEditor?.isFocused === true, null, {
    timeout: 10_000,
  });
}

async function caretAtEndOf(page: Page, marker: string): Promise<void> {
  await focusEditor(page);
  await page.evaluate((needle) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let end = -1;
    editor.state.doc.descendants((node, pos) => {
      if (end !== -1) return false;
      if (node.isTextblock && node.textContent.includes(needle)) {
        end = pos + node.nodeSize - 1;
        return false;
      }
      return true;
    });
    if (end === -1) throw new Error(`no textblock containing ${needle}`);
    editor.commands.setTextSelection(end);
  }, marker);
}

test.describe('an edit inside a JSX component body', () => {
  test('updates the captured source instead of leaving it stale', async ({ page, api }) => {
    await open(page, api);
    expect(await readSource(page)).toBe(SEED);

    await caretAtEndOf(page, 'body text');
    await page.keyboard.type(' edited');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('body text edited');
    const source = await readSource(page);
    expect(source).toContain('<Callout type="note">');
    expect(source).toContain('</Callout>');
    expect(source).toContain('after');
  });

  test('an edit after the component leaves the component bytes alone', async ({ page, api }) => {
    await open(page, api);

    await caretAtEndOf(page, 'after');
    await page.keyboard.type(' the end');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('after the end');
    const source = await readSource(page);
    expect(source).toContain('<Callout type="note">\n\nbody text\n\n</Callout>');
  });
});
