/**
 * Comment annotations stay legible in a real browser.
 *
 * The bug this guards was an inline `display: none` in the PM binding, which
 * the schema sweep covers, and the fix moved legibility into `globals.css`,
 * which `src/globals.comment-annotations.test.ts` covers as text. Neither tier
 * reads a computed style: jsdom loads no stylesheet, and the CSS-as-data check
 * cannot see cascade, specificity, an `@apply` that compiles to a hiding
 * declaration, or an ancestor rule that hides the subtree.
 *
 * This is the only tier that runs the compiled stylesheet with real cascade,
 * so it is where "the author can actually see their annotation" is decided.
 *
 * Requires: Playwright browsers installed. Server provided per-worker by the
 * `workerServer` fixture in `_helpers/fixtures.ts`.
 */

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

  // `toBeVisible` already fails on display/visibility/zero-size, which is the
  // property under test stated in Playwright's own vocabulary.
  await expect(inlineMark).toBeVisible();
  await expect(block).toBeVisible();

  // And the bodies are readable, not merely present in the layout.
  await expect(inlineMark).toHaveText('an inline percent note');
  await expect(block).toContainText('a whole-paragraph html comment');

  // Read the computed style the compiled stylesheet actually produced, so a
  // regression routed through cascade or `@apply hidden` fails here even
  // though it leaves no literal declaration for the CSS-as-data tier to find.
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

  // With no delimiter glyphs, the dimming and the italic ARE the affordance
  // that names an inline annotation, so this tier has to prove they survive
  // the compiled cascade. Comparing against the surrounding prose rather than
  // against the token: a rule that resolved `--muted-foreground` to the body
  // colour would satisfy a token assertion while leaving the run
  // indistinguishable from the sentence it sits in.
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

  // Compared against `em`, not against the comment's own container: `em` is
  // what an inline comment is actually confusable with (both italic, both
  // inline), and a rule that dimmed BOTH would satisfy a self-comparison while
  // leaving them indistinguishable.
  expect(inlineStyle.fontStyle).toBe('italic');
  expect(emStyle.fontStyle).toBe('italic');
  expect(inlineStyle.color).not.toBe(emStyle.color);
  // Colour must not be the only discriminator (WCAG 1.4.1): the two have to
  // differ on a channel that survives forced colors, where `color` does not.
  expect(inlineStyle.textDecorationLine).not.toBe(emStyle.textDecorationLine);
  expect(inlineStyle.textDecorationLine).toContain('underline');

  // The annotation must not be confusable with the blockquote that shares the
  // muted-left-rail treatment a few rules away in the same stylesheet.
  const blockBorder = await block.evaluate((element) => getComputedStyle(element).borderLeftStyle);
  const quoteBorder = await page
    .locator('.ProseMirror blockquote')
    .first()
    .evaluate((element) => getComputedStyle(element).borderLeftStyle);
  expect(blockBorder).toBe('dashed');
  expect(blockBorder).not.toBe(quoteBorder);
});
