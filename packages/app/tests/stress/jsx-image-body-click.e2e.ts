import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test, waitForImageDecoded } from './_helpers';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '_fixtures');

interface ApiSeed {
  seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void>;
}

async function setupDoc(
  page: Page,
  api: ApiSeed,
  markdown: string,
  writeAsset: () => void,
): Promise<string> {
  const docName = `imgclick-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  writeAsset();
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return docName;
}

test('AC21/F4: img body-click does NOT NodeSelect (Zoom interception pin)', async ({
  page,
  api,
  workerServer,
}) => {
  const name = `img-click-${randomUUID().slice(0, 8)}.png`;
  await setupDoc(page, api, `<img src="/${name}" alt="real loaded asset" />\n\nafter\n`, () => {
    writeFileSync(
      join(workerServer.contentDir, name),
      readFileSync(join(FIXTURES_DIR, 'real-shot.png')),
    );
  });

  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().setTextSelection(editor.state.doc.content.size).run();
  });

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(wrapper).toBeVisible();

  const img = wrapper.locator('img').first();
  await expect(img).toBeVisible();
  await waitForImageDecoded(img);
  await img.click();

  const selType = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return 'no-editor';
    return editor.state.selection.constructor.name;
  });
  expect(selType).toBe('TextSelection');
  await expect(wrapper).not.toHaveAttribute('data-selected', 'true');
});
