import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';

const SEED = '# Doc\n\n```js\nconst a = 1;\n```\n\nTail paragraph.\n';

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function open(
  page: Page,
  api: { createPage(p: string): Promise<void>; replaceDoc(d: string, m: string): Promise<void> },
): Promise<void> {
  const docName = `test-code-block-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, SEED);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector(EDITOR);
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 10_000 });
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.textContent?.includes('const a = 1;') ?? false,
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

async function caretAtEndOfCode(page: Page): Promise<void> {
  await focusEditor(page);
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let end = -1;
    editor.state.doc.descendants((node, pos) => {
      if (end !== -1) return false;
      if (node.type.name === 'codeBlock') {
        end = pos + node.nodeSize - 1;
        return false;
      }
      return true;
    });
    if (end === -1) throw new Error('no codeBlock in the document');
    editor.commands.setTextSelection(end);
  });
}

test.describe('authoring inside a fenced code block', () => {
  test('a newline typed in the fence reaches the source without breaking it', async ({
    page,
    api,
  }) => {
    await open(page, api);
    expect(await readSource(page)).toBe(SEED);

    await caretAtEndOfCode(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('const b = 2;');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('const b = 2;');
    const source = await readSource(page);
    expect(source).toContain('const a = 1;\nconst b = 2;');
    expect(source).toContain('```js');
    expect(source).toContain('# Doc');
    expect(source).toContain('Tail paragraph.');
    expect(source.match(/```/g)).toHaveLength(2);
  });

  test('the surrounding blocks survive a character typed in the fence', async ({ page, api }) => {
    await open(page, api);

    await caretAtEndOfCode(page);
    await page.keyboard.type(' // note');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('// note');
    const source = await readSource(page);
    expect(source.startsWith('# Doc\n')).toBe(true);
    expect(source.trimEnd().endsWith('Tail paragraph.')).toBe(true);
  });
});
