
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
  await page.waitForSelector('.ProseMirror');
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

  const selType = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return 'no-editor';
    return editor.state.selection.constructor.name;
  });
  expect(selType).toBe('TextSelection');
  await expect(wrapper).not.toHaveAttribute('data-selected', 'true');
});
