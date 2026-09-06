import { randomUUID } from 'node:crypto';
import { expect, test, toggleMode } from './_helpers';

async function docShape(page: import('@playwright/test').Page): Promise<{
  blocks: string[];
  source: string;
}> {
  return page.evaluate(() => {
    const doc = window.__activeEditor?.state.doc;
    const blocks: string[] = [];
    if (doc) for (let i = 0; i < doc.childCount; i++) blocks.push(doc.child(i).textContent);
    return {
      blocks,
      source: window.__activeProvider?.document?.getText('source')?.toString() ?? '',
    };
  });
}

test('an empty paragraph that gains content reclaims the blank line that spelled it', async ({
  page,
  api,
}) => {
  const docName = `blank-run-materialize-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);

  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.locator('.ProseMirror:not(.composer-prosemirror)').click();
  await page.waitForFunction(() => window.__activeEditor?.isFocused === true, null, {
    timeout: 10_000,
  });

  const sourceIs = async (expected: string): Promise<void> => {
    await expect
      .poll(async () => (await docShape(page)).source, { timeout: 10_000 })
      .toBe(expected);
  };

  await page.keyboard.type('hello', { delay: 30 });
  await sourceIs('hello\n');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await docShape(page)).blocks.length, { timeout: 10_000 }).toBe(3);
  await page.keyboard.type('hello', { delay: 30 });
  await sourceIs('hello\n\n\nhello\n');

  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('no active editor');
    let pos = 0;
    for (let i = 0; i < editor.state.doc.childCount; i++) {
      const child = editor.state.doc.child(i);
      if (i > 0 && child.content.size === 0) {
        editor.commands.setTextSelection(pos + 1);
        return;
      }
      pos += child.nodeSize;
    }
    throw new Error('no empty paragraph to type into');
  });
  await page.keyboard.type('error', { delay: 30 });

  await expect
    .poll(async () => (await docShape(page)).source, { timeout: 10_000 })
    .toContain('error');

  const typed = await docShape(page);
  expect(typed.blocks).toEqual(['hello', 'error', 'hello']);
  expect(
    typed.source,
    'the blank line that spelled the empty paragraph was left behind after it gained content',
  ).toBe('hello\n\nerror\n\nhello\n');

  await toggleMode(page, 'source');
  await toggleMode(page, 'wysiwyg');

  const roundTripped = await docShape(page);
  expect(
    roundTripped.blocks,
    'a mode round trip grew a paragraph the document did not have',
  ).toEqual(['hello', 'error', 'hello']);
  expect(roundTripped.source).toBe('hello\n\nerror\n\nhello\n');
});
