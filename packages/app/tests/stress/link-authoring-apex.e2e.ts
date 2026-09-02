import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { Node as PMNode } from '@tiptap/pm/model';
import { expect, focusEditor, selectText, test, waitForActiveProviderSynced } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const LINK_CHIP = `${EDITOR} span[data-link]`;
const PALETTE = '[cmdk-root]';

async function pmHasLink(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    JSON.stringify(window.__activeEditor?.state.doc.toJSON() ?? {}).includes('"type":"link"'),
  );
}

async function waitForYTextToContain(page: Page, needle: string): Promise<void> {
  await page.waitForFunction(
    (n: string) =>
      (window.__activeProvider?.document?.getText('source')?.toString() ?? '').includes(n),
    needle,
    { timeout: 10_000 },
  );
}

test.describe('apex — cross-writer linkification never fires', () => {
  test('a boundary-less URL typed by a peer stays plain on the receiver; only a client’s own boundary-typed URL converts', async ({
    browser,
    api,
    baseURL,
  }) => {
    const docName = `test-link-apex-fr1-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    const ctxA = await browser.newContext({ baseURL });
    const ctxB = await browser.newContext({ baseURL });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await Promise.all([pageA.goto(`/#/${docName}`), pageB.goto(`/#/${docName}`)]);
      await Promise.all([
        pageA.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 }),
        pageB.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 }),
      ]);
      await Promise.all([pageA.waitForSelector(EDITOR), pageB.waitForSelector(EDITOR)]);

      await pageA.locator(EDITOR).click();
      await pageA.keyboard.type('https://a-side.com');
      await waitForYTextToContain(pageB, 'a-side.com');

      expect(await pmHasLink(pageA)).toBe(false);
      expect(await pmHasLink(pageB)).toBe(false);
      await expect(pageA.locator(LINK_CHIP)).toHaveCount(0);
      await expect(pageB.locator(LINK_CHIP)).toHaveCount(0);

      await pageB.locator(EDITOR).click();
      await pageB.evaluate(() => window.__activeEditor?.commands.focus('start'));
      await pageB.keyboard.type('https://b-own.com ');

      await pageB.waitForFunction(
        () =>
          JSON.stringify(window.__activeEditor?.state.doc.toJSON() ?? {}).includes('"type":"link"'),
        null,
        { timeout: 5_000 },
      );

      await expect(pageB.locator(`${LINK_CHIP}[aria-label="Link: https://b-own.com"]`)).toHaveCount(
        1,
      );
      await expect(pageB.locator(LINK_CHIP)).toHaveCount(1);

      await waitForYTextToContain(pageA, 'b-own.com');
      await expect(pageA.locator(`${LINK_CHIP}[aria-label="Link: https://b-own.com"]`)).toHaveCount(
        1,
      );
      await expect(pageA.locator(LINK_CHIP)).toHaveCount(1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

test.describe('apex — backgrounded editor never linkifies', () => {
  test('a peer’s boundary-less URL reaches a hidden Activity’s editor and stays plain', async ({
    browser,
    api,
    baseURL,
  }) => {
    const docX = `test-link-apex-hidx-${randomUUID().slice(0, 8)}`;
    const docY = `test-link-apex-hidy-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docX}.md`);
    await api.createPage(`${docY}.md`);

    const ctxH = await browser.newContext({ baseURL });
    const ctxM = await browser.newContext({ baseURL });
    const pageH = await ctxH.newPage();
    const pageM = await ctxM.newPage();

    try {
      await pageH.goto(`/#/${docX}`);
      await pageH.waitForFunction(() => Boolean(window.__activeProvider), null, {
        timeout: 15_000,
      });
      await pageH.waitForSelector(EDITOR);
      await pageH.goto(`/#/${docY}`);
      await pageH.waitForFunction(() => Boolean(window.__activeProvider), null, {
        timeout: 15_000,
      });
      await pageH.waitForSelector(EDITOR);

      await pageM.goto(`/#/${docX}`);
      await pageM.waitForFunction(() => Boolean(window.__activeProvider), null, {
        timeout: 15_000,
      });
      await pageM.waitForSelector(EDITOR);
      await pageM.locator(EDITOR).click();
      await pageM.keyboard.type('https://while-hidden.com');
      await waitForYTextToContain(pageM, 'while-hidden.com');

      await pageH.waitForFunction(
        (doc: string) =>
          (
            window.__providerPool?.peek(doc)?.provider?.document?.getText('source')?.toString() ??
            ''
          ).includes('while-hidden.com'),
        docX,
        { timeout: 10_000 },
      );
      await pageH.goto(`/#/${docX}`);
      await pageH.waitForFunction(() => Boolean(window.__activeProvider), null, {
        timeout: 15_000,
      });
      await waitForYTextToContain(pageH, 'while-hidden.com');

      expect(await pmHasLink(pageH)).toBe(false);
      await expect(pageH.locator(LINK_CHIP)).toHaveCount(0);
    } finally {
      await ctxH.close();
      await ctxM.close();
    }
  });
});

test.describe('apex — ⌘K dual-role routing', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-link-apex-cmdk-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await page.waitForSelector(EDITOR);
    await api.replaceDoc(
      docName,
      'edit this text and visit [the docs](https://example.com) often\n',
    );
    await waitForYTextToContain(page, 'the docs');
    await expect(page.locator(LINK_CHIP)).toHaveCount(1);
  });

  test('non-empty selection routes ⌘K to the link popover, not the palette', async ({ page }) => {
    await selectText(page, 'this text');
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+k');

    const input = page.getByLabel('Link URL');
    await expect(input).toBeVisible({ timeout: 2_000 });
    await expect(page.locator(PALETTE)).toHaveCount(0);

    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')), {
        timeout: 2_000,
      })
      .toBe('Link URL');
    await page.keyboard.press('Escape');
    await expect(input).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(input).toBeHidden({ timeout: 2_000 });
    await expect
      .poll(() => page.evaluate(() => window.__activeEditor?.view.hasFocus() ?? false), {
        timeout: 2_000,
      })
      .toBe(true);
  });

  test('collapsed caret in plain text routes ⌘K to the palette', async ({ page }) => {
    await page.evaluate(() => {
      const ed = window.__activeEditor;
      if (!ed) throw new Error('no active editor');
      const idx = ed.state.doc.textContent.indexOf('often');
      ed.chain()
        .focus()
        .setTextSelection(idx + 2)
        .run();
    });
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+k');

    await expect(page.locator(PALETTE)).toBeVisible({ timeout: 2_000 });
  });

  test('caret inside a link routes ⌘K to the chip edit surface, not the palette', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const ed = window.__activeEditor;
      if (!ed) throw new Error('no active editor');
      let pos = -1;
      ed.state.doc.descendants((node: PMNode, at: number) => {
        if (pos !== -1) return false;
        if (node.isText && node.marks.some((m) => m.type.name === 'link')) {
          pos = at + 1;
          return false;
        }
        return true;
      });
      if (pos === -1) throw new Error('no link mark found to place caret in');
      ed.chain().focus().setTextSelection(pos).run();
    });
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+k');

    await expect(page.getByRole('combobox', { name: 'Link target' })).toBeVisible({
      timeout: 2_000,
    });
    await expect(page.locator(PALETTE)).toHaveCount(0);
  });

  test('⌘⇧K does NOT open the palette (exact-⌘K narrowing)', async ({ page }) => {
    await page.locator(EDITOR).click();
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+Shift+k');
    await expect(page.locator(PALETTE)).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator(PALETTE)).toBeVisible({ timeout: 2_000 });
  });

  test('⌘K in the source pane routes to the palette (WYSIWYG lacks focus)', async ({ page }) => {
    await page.getByRole('radio', { name: 'Markdown source' }).click();
    const cm = page.locator('.cm-content');
    await expect(cm).toBeVisible({ timeout: 5_000 });
    await cm.click();
    await page.keyboard.press('ControlOrMeta+k');

    await expect(page.locator(PALETTE)).toBeVisible({ timeout: 2_000 });
  });
});

test.describe('apex — clipboard pre-fill under real permission denial', () => {
  test('with clipboard-read withheld, the popover opens empty and stays functional', async ({
    browser,
    api,
    baseURL,
  }) => {
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    try {
      const docName = `test-link-apex-clip-${randomUUID().slice(0, 8)}`;
      await api.createPage(`${docName}.md`);
      await page.goto(`/#/${docName}`);
      await waitForActiveProviderSynced(page);
      await page.waitForSelector(EDITOR);
      await api.replaceDoc(docName, 'select me and link\n');
      await waitForYTextToContain(page, 'select me');

      await selectText(page, 'select me');
      await focusEditor(page);
      await page.keyboard.press('ControlOrMeta+k');

      const input = page.getByLabel('Link URL');
      await expect(input).toBeVisible({ timeout: 2_000 });
      await expect(input).toHaveValue('');

      await input.fill('https://typed-by-hand.com');
      await page.keyboard.press('Enter');
      await expect(
        page.locator(`${LINK_CHIP}[aria-label="Link: https://typed-by-hand.com"]`),
      ).toHaveCount(1, { timeout: 5_000 });
    } finally {
      await ctx.close();
    }
  });
});
