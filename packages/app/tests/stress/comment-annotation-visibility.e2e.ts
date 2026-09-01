import { expect, test, waitForActiveProviderSynced } from './_helpers';

const SEED = [
  'Ordinary prose above with *plain emphasis* in it.',
  '',
  '> An ordinary blockquote.',
  '',
  'A sentence with %%an inline percent note%% inside it.',
  '',
  'A sentence with <!-- an inline html note --> inside it.',
  '',
  '<!-- a whole-paragraph html comment -->',
  '',
  '%%',
  '',
  'A multi-line percent comment block.',
  '',
  '%%',
  '',
  'Ordinary prose below.',
].join('\n');

test('promoted comment annotations render visibly, not hidden', async ({ page, api }) => {
  const docName = `comment-visibility-${Date.now()}`;
  await api.seedDocs([{ name: docName, markdown: SEED }]);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const editor = page.locator('.tiptap-editor .ProseMirror').first();
  await expect(editor).toContainText('Ordinary prose above');

  const inlineMark = page.locator('.tiptap-editor [data-comment-mark]').first();
  const block = page.locator('.tiptap-editor [data-comment-block]').first();

  await expect(inlineMark).toBeVisible();
  await expect(block).toBeVisible();

  await expect(inlineMark).toHaveText('an inline percent note');
  await expect(block).toContainText('a whole-paragraph html comment');

  for (const locator of [inlineMark, block]) {
    const computed = await locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        display: style.display,
        visibility: style.visibility,
        opacity: Number.parseFloat(style.opacity),
      };
    });
    expect(computed.display).not.toBe('none');
    expect(computed.visibility).not.toBe('hidden');
    expect(computed.opacity).toBeGreaterThan(0);
  }

  const inlineStyle = await inlineMark.evaluate((element) => {
    const own = getComputedStyle(element);
    return {
      color: own.color,
      fontStyle: own.fontStyle,
      textDecorationLine: own.textDecorationLine,
    };
  });
  const emStyle = await page
    .locator('.ProseMirror em')
    .first()
    .evaluate((element) => {
      const own = getComputedStyle(element);
      return {
        color: own.color,
        fontStyle: own.fontStyle,
        textDecorationLine: own.textDecorationLine,
      };
    });

  expect(inlineStyle.fontStyle).toBe('italic');
  expect(emStyle.fontStyle).toBe('italic');
  expect(inlineStyle.color).not.toBe(emStyle.color);
  expect(inlineStyle.textDecorationLine).not.toBe(emStyle.textDecorationLine);
  expect(inlineStyle.textDecorationLine).toContain('underline');

  const blockBorder = await block.evaluate((element) => getComputedStyle(element).borderLeftStyle);
  const quoteBorder = await page
    .locator('.ProseMirror blockquote')
    .first()
    .evaluate((element) => getComputedStyle(element).borderLeftStyle);
  expect(blockBorder).toBe('dashed');
  expect(blockBorder).not.toBe(quoteBorder);
});
