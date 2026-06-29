import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

async function getYText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

async function getEditorStructure(page: Page) {
  return page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return { text: '', h1Count: 0, h2Count: 0, pCount: 0, hasRawFallback: false };
    return {
      text: pm.textContent ?? '',
      h1Count: pm.querySelectorAll('h1').length,
      h2Count: pm.querySelectorAll('h2').length,
      pCount: pm.querySelectorAll('p').length,
      hasRawFallback: pm.querySelectorAll('[data-raw-mdx-fallback]').length > 0,
    };
  });
}

async function getXmlFragmentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    if (!provider?.document) return '';
    const fragment = provider.document.getXmlFragment('default');
    const texts: string[] = [];
    const walk = (node: { toArray?: () => unknown[]; toString?: () => string }) => {
      if (typeof node.toString === 'function' && !node.toArray) {
        texts.push(node.toString());
      }
      if (typeof node.toArray === 'function') {
        for (const child of node.toArray()) {
          if (child && typeof child === 'object') {
            walk(child as { toArray?: () => unknown[]; toString?: () => string });
          }
        }
      }
    };
    walk(fragment as unknown as { toArray: () => unknown[] });
    return texts.join('');
  });
}

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const visualToggle = (page: Page) => page.getByRole('radio', { name: 'Visual editor' });

let docName: string;

test.beforeEach(async ({ page, api }) => {
  docName = `test-midtype-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror');
});

test('mid-type recovery: surrounding structure stable during <Callout> character-by-character typing', async ({
  page,
  api,
}) => {
  const seedMd = '# Top Heading\n\nParagraph above.\n\n## Bottom Heading\n\nParagraph below.\n';
  await api.replaceDoc(docName, seedMd);

  await page.waitForFunction(
    () => document.querySelector('.ProseMirror')?.textContent?.includes('Top Heading'),
    null,
    { timeout: 10_000 },
  );

  const initialStructure = await getEditorStructure(page);
  expect(initialStructure.h1Count).toBe(1);
  expect(initialStructure.h2Count).toBe(1);

  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');
  await page.locator('.cm-content').focus();

  await page.keyboard.press('ControlOrMeta+End');

  const fullText = '\n\n<Callout type="warning">Hello world</Callout>';
  await page.keyboard.type(fullText, { delay: 30 });

  await page.waitForFunction(
    () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('</Callout>'),
    null,
    { timeout: 10_000 },
  );

  let lastFragLen = -1;
  let stableTicks = 0;
  await expect
    .poll(
      async () => {
        const len = (await getXmlFragmentText(page)).length;
        if (len > 0 && len === lastFragLen) stableTicks += 1;
        else stableTicks = 0;
        lastFragLen = len;
        return stableTicks;
      },
      { intervals: [100], timeout: 5_000 },
    )
    .toBeGreaterThanOrEqual(3);

  const fragmentText = await getXmlFragmentText(page);
  expect(fragmentText).toContain('Top Heading');
  expect(fragmentText).toContain('Bottom Heading');
  expect(fragmentText).toContain('Paragraph above');
  expect(fragmentText).toContain('Paragraph below');

  const finalYText = await getYText(page);
  expect(finalYText).toContain('Hello world');
  expect(finalYText).toContain('</Callout>');
  expect(finalYText).toContain('# Top Heading');
  expect(finalYText).toContain('## Bottom Heading');

  await visualToggle(page).click();
  await page.waitForSelector('.ProseMirror');

  await page.waitForFunction(
    () => (document.querySelector('.ProseMirror')?.textContent?.length ?? 0) > 10,
    null,
    { timeout: 10_000 },
  );

  const finalStructure = await getEditorStructure(page);
  expect(finalStructure.text).toContain('Top Heading');
  expect(finalStructure.text).toContain('Paragraph above');
});

test('mid-type recovery: tag mismatch shows rawMdxFallback with surrounding structure intact', async ({
  page,
  api,
}) => {
  const seedMd = '# Header\n\nAbove paragraph.\n\n## Sub Header\n\nBelow paragraph.\n';
  await api.replaceDoc(docName, seedMd);

  await page.waitForFunction(
    () => document.querySelector('.ProseMirror')?.textContent?.includes('Header'),
    null,
    { timeout: 10_000 },
  );

  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');
  await page.locator('.cm-content').focus();

  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\n<Foo>some text</Bar>\n', { delay: 10 });

  await page.waitForFunction(
    () =>
      window.__activeProvider?.document
        ?.getText('source')
        ?.toString()
        ?.includes('<Foo>some text</Bar>'),
    null,
    { timeout: 10_000 },
  );

  await visualToggle(page).click();
  await page.waitForSelector('.ProseMirror');

  await page.waitForFunction(
    () => {
      const pm = document.querySelector('.ProseMirror');
      return pm?.querySelectorAll('h1').length === 1 && pm?.querySelectorAll('h2').length === 1;
    },
    null,
    { timeout: 10_000 },
  );

  const structure = await getEditorStructure(page);
  expect(structure.h1Count).toBe(1);
  expect(structure.h2Count).toBe(1);
  expect(structure.text).toContain('Header');
  expect(structure.text).toContain('Above paragraph');
  expect(structure.text).toContain('Below paragraph');

  const ytext = await getYText(page);
  expect(ytext).toContain('<Foo>some text</Bar>');
});

test('mid-type recovery: partial attribute does not collapse document', async ({ page, api }) => {
  const seedMd = '# Title\n\nContent here.\n';
  await api.replaceDoc(docName, seedMd);

  await page.waitForFunction(
    () => document.querySelector('.ProseMirror')?.textContent?.includes('Title'),
    null,
    { timeout: 10_000 },
  );

  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');
  await page.locator('.cm-content').focus();

  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\n<Foo a=', { delay: 20 });

  await page.waitForFunction(
    () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('<Foo a='),
    null,
    { timeout: 10_000 },
  );

  await visualToggle(page).click();
  await page.waitForSelector('.ProseMirror');

  await page.waitForFunction(
    () => document.querySelector('.ProseMirror')?.querySelectorAll('h1').length === 1,
    null,
    { timeout: 10_000 },
  );

  const structure = await getEditorStructure(page);
  expect(structure.h1Count).toBe(1);
  expect(structure.text).toContain('Title');
  expect(structure.text).toContain('Content here');
});
