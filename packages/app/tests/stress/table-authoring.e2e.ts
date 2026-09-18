import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';

const SEED =
  '# Doc\n\n| head a | head b |\n| ------ | ------ |\n| one    | two    |\n\nTail paragraph.\n';

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function open(
  page: Page,
  api: { createPage(p: string): Promise<void>; replaceDoc(d: string, m: string): Promise<void> },
): Promise<void> {
  const docName = `test-table-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, SEED);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector(`${EDITOR} table`);
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 10_000 });
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.textContent?.includes('head a') ?? false,
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

async function caretAtEndOfCell(page: Page, marker: string): Promise<void> {
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

test.describe('authoring inside a table', () => {
  test('a character typed in a body cell reaches the source with the table intact', async ({
    page,
    api,
  }) => {
    await open(page, api);
    expect(await readSource(page)).toBe(SEED);

    await caretAtEndOfCell(page, 'one');
    await page.keyboard.type('X');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('oneX');
    const source = await readSource(page);
    expect(source).toContain('head a');
    expect(source).toContain('head b');
    expect(source).toContain('two');
    expect(source).toContain('# Doc');
    expect(source).toContain('Tail paragraph.');
    expect(source.split('\n').filter((l) => l.trimStart().startsWith('|'))).toHaveLength(3);
  });

  test('a character typed in a header cell keeps the delimiter row', async ({ page, api }) => {
    await open(page, api);

    await caretAtEndOfCell(page, 'head b');
    await page.keyboard.type('Z');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('head bZ');
    const source = await readSource(page);
    expect(source).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/);
    expect(source).toContain('Tail paragraph.');
  });
});
