import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';

const TALL_DOC_WITH_TABLE = `${Array.from(
  { length: 12 },
  (_, i) => `Paragraph ${i + 1} of filler, here to make the document taller than the editor.`,
).join('\n\n')}

| Col A | Col B |
| ----- | ----- |
| one   | two   |
`;

const TYPED_MARKER = 'zoneauthored';

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

const TRAILING_WIDGET_CLASSES = ['ok-trailing-affordance', 'ProseMirror-gapcursor'];

function lastRealBlockMetrics(
  page: Page,
): Promise<{ bottom: number; marginBottom: number } | null> {
  return page.evaluate(
    ({ selector, widgets }) => {
      const editor = document.querySelector(selector);
      if (!editor) return null;
      let last = editor.lastElementChild;
      while (last && widgets.some((name) => last?.classList.contains(name))) {
        last = last.previousElementSibling;
      }
      if (!last) return null;
      const margin = Number.parseFloat(getComputedStyle(last).marginBottom || '0');
      return {
        bottom: last.getBoundingClientRect().bottom,
        marginBottom: Number.isFinite(margin) ? margin : 0,
      };
    },
    { selector: EDITOR, widgets: TRAILING_WIDGET_CLASSES },
  );
}

async function measureZoneHeight(page: Page): Promise<number> {
  const block = await lastRealBlockMetrics(page);
  if (!block) return -1;
  const edge = await page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    if (!editor) return null;
    const composer = Number.parseFloat(
      getComputedStyle(editor).getPropertyValue('--ask-composer-height') || '0',
    );
    return {
      bottom: editor.getBoundingClientRect().bottom,
      composer: Number.isFinite(composer) ? composer : 0,
    };
  }, EDITOR);
  if (!edge) return -1;
  return edge.bottom - edge.composer - block.marginBottom - block.bottom;
}

async function zoneClickPoint(page: Page): Promise<{ x: number; y: number }> {
  await page.evaluate((selector) => {
    const scroll = document.querySelector(selector)?.closest('.editor-doc-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, EDITOR);
  await page.waitForFunction(
    (selector) => {
      const scroll = document.querySelector(selector)?.closest('.editor-doc-scroll');
      if (!scroll) return false;
      return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
    },
    EDITOR,
    { timeout: 10_000 },
  );

  const block = await lastRealBlockMetrics(page);
  expect(block, 'the fixture must have a last block below the hint').not.toBeNull();
  // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
  const lastBottom = block!.bottom;

  const probe = await page.evaluate(
    ({ selector, lastBottom: blockBottom }) => {
      const editor = document.querySelector(selector);
      const scroll = editor?.closest('.editor-doc-scroll');
      if (!editor || !scroll) return null;
      const editorBox = editor.getBoundingClientRect();
      const composer = Number.parseFloat(
        getComputedStyle(editor).getPropertyValue('--ask-composer-height') || '0',
      );
      const clearBottom = Math.min(
        editorBox.bottom,
        scroll.getBoundingClientRect().bottom - composer,
      );
      const x = editorBox.left + 80;
      const blockers: string[] = [];
      for (let y = blockBottom + 2; y <= clearBottom - 2; y += 2) {
        const hit = document.elementFromPoint(x, y);
        if (hit === editor) return { x, y, clearBandHeight: clearBottom - blockBottom, blockers };
        const tag = hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : 'null';
        if (!blockers.includes(tag)) blockers.push(tag);
      }
      return { x, y: null, clearBandHeight: clearBottom - blockBottom, blockers };
    },
    { selector: EDITOR, lastBottom },
  );

  expect(probe, 'editor and scrollport must both be present').not.toBeNull();
  // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
  const found = probe!;
  expect(
    found.y,
    `no row in the ${found.clearBandHeight.toFixed(0)}px band below the last block reaches the editor; blocked by ${found.blockers.join(', ')}`,
  ).not.toBeNull();
  // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
  return { x: found.x, y: found.y! };
}

test.describe('trailing affordance geometry', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-trailing-affordance-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, TALL_DOC_WITH_TABLE);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector(EDITOR);
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.querySelector('table') != null,
      EDITOR,
      { timeout: 10_000 },
    );
  });

  test('a document ending in a table leaves a clickable zone below it', async ({ page }) => {
    const editorHeight = await page.evaluate(
      (selector) => document.querySelector(selector)?.getBoundingClientRect().height ?? 0,
      EDITOR,
    );
    expect(editorHeight).toBeGreaterThan(200);

    expect(await measureZoneHeight(page)).toBeGreaterThan(16);
  });

  test('clicking the zone authors a paragraph the document keeps', async ({ page }) => {
    const before = await readSource(page);
    expect(before.trimEnd().endsWith('|')).toBe(true);
    expect(before.endsWith('\n\n')).toBe(false);

    const point = await zoneClickPoint(page);
    await page.mouse.click(point.x, point.y);

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toMatch(/\|\s*\n\n$/);
    await expect(page.locator('.ProseMirror-gapcursor')).toHaveCount(0);

    await page.keyboard.type(TYPED_MARKER);
    await expect
      .poll(() => readSource(page), { timeout: 10_000 })
      .toMatch(new RegExp(`\\|\\s*\\n\\s*${TYPED_MARKER}\\s*$`));
  });

  test('the "+" hint sits in the gutter, left of the text column', async ({ page }) => {
    const point = await zoneClickPoint(page);
    await page.mouse.move(point.x, point.y);

    const plus = page.locator('.ok-trailing-affordance-plus');
    await expect(plus).toBeVisible({ timeout: 10_000 });

    const geometry = await page.evaluate((selector) => {
      const editor = document.querySelector(selector);
      const glyph = document.querySelector('.ok-trailing-affordance-plus');
      if (!editor || !glyph) return null;
      const style = getComputedStyle(editor);
      const editorBox = editor.getBoundingClientRect();
      return {
        glyphRight: glyph.getBoundingClientRect().right,
        textColumnLeft: editorBox.left + Number.parseFloat(style.paddingLeft),
      };
    }, EDITOR);
    expect(geometry).not.toBeNull();

    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(geometry!.glyphRight).toBeLessThanOrEqual(geometry!.textColumnLeft);
  });

  test('the composer inset adds to the trailing zone rather than replacing it', async ({
    page,
  }) => {
    const padding = await page.evaluate((selector) => {
      const editor = document.querySelector<HTMLElement>(selector);
      if (!editor) return null;
      const style = getComputedStyle(editor);
      const px = (name: string) => Number.parseFloat(style.getPropertyValue(name) || '0');
      return {
        paddingBottom: Number.parseFloat(style.paddingBottom),
        composer: px('--ask-composer-height'),
        zone:
          Number.parseFloat(style.getPropertyValue('--ok-trailing-zone') || '0') *
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      };
    }, EDITOR);
    expect(padding).not.toBeNull();

    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(padding!.composer).toBeGreaterThan(0);
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(padding!.zone).toBeGreaterThan(0);
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(padding!.paddingBottom).toBeCloseTo(padding!.composer + padding!.zone, 1);
  });

  test('the gapcursor after a trailing table is drawn in the theme color', async ({ page }) => {
    await page.locator(`${EDITOR} table td`).last().click();

    const gapcursor = page.locator('.ProseMirror-gapcursor');
    await expect
      .poll(
        async () => {
          await page.keyboard.press('ArrowDown');
          return gapcursor.count();
        },
        { timeout: 10_000 },
      )
      .toBe(1);

    const painted = await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror-gapcursor');
      if (!el) return null;
      const probe = document.createElement('div');
      probe.style.borderTopColor = 'var(--foreground)';
      el.appendChild(probe);
      const expected = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return {
        actual: getComputedStyle(el, '::after').borderTopColor,
        expected,
        token: getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim(),
      };
    });
    expect(painted).not.toBeNull();

    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(painted!.token).not.toBe('');
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(painted!.actual).toBe(painted!.expected);
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(painted!.actual).not.toBe('rgb(0, 0, 0)');
  });

  test.describe('on a coarse pointer at the narrow rail', () => {
    test.use({ hasTouch: true, viewport: { width: 390, height: 780 } });

    test('the hint is present without a hover and sits inside the editor', async ({ page }) => {
      expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true);

      const plus = page.locator('.ok-trailing-affordance-plus');
      await expect(plus).toBeVisible({ timeout: 10_000 });

      const geometry = await page.evaluate((selector) => {
        const editor = document.querySelector(selector);
        const glyph = document.querySelector('.ok-trailing-affordance-plus');
        if (!editor || !glyph) return null;
        const editorBox = editor.getBoundingClientRect();
        const glyphBox = glyph.getBoundingClientRect();
        return { editorLeft: editorBox.left, glyphLeft: glyphBox.left, glyphWidth: glyphBox.width };
      }, EDITOR);
      expect(geometry).not.toBeNull();

      // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
      expect(geometry!.glyphWidth).toBeGreaterThan(0);
      // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
      expect(geometry!.glyphLeft).toBeGreaterThanOrEqual(geometry!.editorLeft);
    });
  });
});
