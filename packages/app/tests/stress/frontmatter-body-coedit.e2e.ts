import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';

const FRONTMATTER = '---\ntitle: Kept exactly\ntags:\n  - alpha\n  - beta\n---\n\n';
const SEED = `${FRONTMATTER}Body paragraph.\n\nSecond paragraph.\n`;

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function open(
  page: Page,
  api: { createPage(p: string): Promise<void>; replaceDoc(d: string, m: string): Promise<void> },
): Promise<void> {
  const docName = `test-frontmatter-body-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, SEED);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector(EDITOR);
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 10_000 });
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.textContent?.includes('Body paragraph.') ?? false,
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

test.describe('a body edit alongside frontmatter', () => {
  test('leaves the frontmatter bytes untouched', async ({ page, api }) => {
    await open(page, api);
    expect(await readSource(page)).toBe(SEED);

    await caretAtEndOf(page, 'Body paragraph.');
    await page.keyboard.type(' Extended.');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('Extended.');
    const source = await readSource(page);
    expect(source.startsWith(FRONTMATTER)).toBe(true);
    expect(source).toContain('Body paragraph. Extended.');
    expect(source).toContain('Second paragraph.');
  });

  test('a new paragraph after the last one keeps the frontmatter at the top', async ({
    page,
    api,
  }) => {
    await open(page, api);

    await caretAtEndOf(page, 'Second paragraph.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Third paragraph.');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('Third paragraph.');
    const source = await readSource(page);
    expect(source.startsWith(FRONTMATTER)).toBe(true);
    expect(source.indexOf('title: Kept exactly')).toBeLessThan(source.indexOf('Body paragraph.'));
  });
});
