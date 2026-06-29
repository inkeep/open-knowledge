import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

async function seedMarkdown(api: ApiHelpers, docName: string, markdown: string) {
  await api.replaceDoc(docName, markdown);
}

/** Switch to source mode and wait for CodeMirror to render. CM6 paints decorations
 * synchronously on the next animation frame after the editor mounts, so waiting
 * for `.cm-line` elements to appear (any non-empty doc produces at least one)
 * is a reliable condition-based wait — no fixed-duration timeout needed. */
async function switchToSource(page: Page) {
  await page.getByRole('radio', { name: 'Markdown source' }).click();
  await page.waitForSelector('.cm-content', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('.cm-line').length > 0, null, {
    timeout: 5_000,
  });
}

const errors: LogEntry[] = [];

let testDocName = '';

test.beforeEach(async ({ page, api }) => {
  errors.length = 0;
  page.on('pageerror', (err) => errors.push({ type: 'uncaught', text: err.message }));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      errors.push({ type: 'error', text: msg.text(), url: loc.url, line: loc.lineNumber });
    }
  });

  testDocName = `sp-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${testDocName}.md`);
  await page.goto(`/#/${testDocName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror');
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

test.describe('§6.2 Strikethrough', () => {
  test('~~text~~ renders cm-del on content only, not delimiters', async ({ page, api }) => {
    await seedMarkdown(api, testDocName, '~~deprecated~~ text');
    await switchToSource(page);

    const delSpans = page.locator('.cm-content .cm-del');
    await expect(delSpans).toHaveCount(1);

    const delText = await delSpans.first().textContent();
    expect(delText).toBe('deprecated');

    const lineText = await page.locator('.cm-line').first().textContent();
    expect(lineText).toContain('~~deprecated~~');
  });
});

test.describe('§6.3 List hanging-indent', () => {
  test('wrapped bullet list line left edge aligns with plain paragraph (marker not pushed off-screen)', async ({
    page,
    api,
  }) => {
    const longText = 'A'.repeat(200);
    await seedMarkdown(api, testDocName, `- ${longText}\n\nplain paragraph`);
    await switchToSource(page);

    await page.setViewportSize({ width: 400, height: 600 });

    const listLine = page.locator('.cm-line.cm-list-item').first();
    await expect(listLine).toBeVisible();

    const listLineBox = await listLine.boundingBox();
    expect(listLineBox).toBeTruthy();

    const plainLine = page.locator('.cm-line:not(.cm-list-item)').first();
    const plainBox = await plainLine.boundingBox();
    expect(plainBox).toBeTruthy();

    expect(Math.abs(listLineBox?.x - plainBox?.x)).toBeLessThan(50);
  });
});

test.describe('§6.5 Code wrap-preserve-indent', () => {
  test('source indent is visible (not flattened)', async ({ page, api }) => {
    await seedMarkdown(api, testDocName, '```js\nfoo\n    bar\n        baz\n```');
    await switchToSource(page);

    const codeLines = page.locator('.cm-line.cm-fenced-code-line');
    const count = await codeLines.count();
    expect(count).toBeGreaterThanOrEqual(3);

    const boxes = [];
    for (let i = 0; i < count; i++) {
      const box = await codeLines.nth(i).boundingBox();
      if (box) boxes.push(box);
    }

    expect(boxes.length).toBeGreaterThanOrEqual(3);
  });

  test('long indented code line wraps under the indent', async ({ page, api }) => {
    const longLine = `    ${'x'.repeat(300)}`;
    await seedMarkdown(api, testDocName, `\`\`\`js\n${longLine}\n\`\`\``);
    await switchToSource(page);

    await page.setViewportSize({ width: 400, height: 600 });

    const codeLine = page.locator('.cm-line.cm-fenced-code-line').first();
    await expect(codeLine).toBeVisible();

    const lineIndent = await codeLine.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('padding-inline-start'),
    );
    expect(lineIndent).not.toBe('0px');
  });
});

test.describe('§6.1 Broken wikilink', () => {
  test('[[NonexistentPage]] gets cm-wiki-link-broken after cache warms', async ({ page, api }) => {
    await seedMarkdown(api, testDocName, '[[DefinitelyNotAPage12345]]');
    await switchToSource(page);

    const brokenLink = page.locator('.cm-wiki-link-broken');
    await expect(brokenLink).toBeVisible({ timeout: 10_000 });
  });

  test('[[test-doc]] (existing page) does NOT get broken class', async ({ page, api }) => {
    await seedMarkdown(api, testDocName, '[[test-doc]]');
    await switchToSource(page);

    const wikiLink = page.locator('.cm-wiki-link');
    await expect(wikiLink).toHaveCount(1, { timeout: 10_000 });

    const brokenLink = page.locator('.cm-wiki-link-broken');
    await expect(brokenLink).toHaveCount(0);
  });
});

test.describe('§6.6 Tables (structure/layout only)', () => {
  test('header + row + delimiter get structural classes; no styling', async ({ page, api }) => {
    await seedMarkdown(
      api,
      testDocName,
      'plain paragraph\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nanother paragraph',
    );
    await switchToSource(page);

    const allLines = page.locator('.cm-line');
    const lineCount = await allLines.count();
    expect(lineCount).toBeGreaterThanOrEqual(5);

    const paragraphFontSize = await allLines
      .filter({ hasText: 'plain paragraph' })
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize);

    let headerSeen = 0;
    let rowSeen = 0;
    let delimiterSeen = 0;

    for (let i = 0; i < lineCount; i++) {
      const classes = (await allLines.nth(i).getAttribute('class')) ?? '';
      const text = (await allLines.nth(i).textContent()) ?? '';

      if (!text.includes('|')) {
        expect(classes).not.toContain('cm-table-row');
        expect(classes).not.toContain('cm-table-header');
        continue;
      }

      if (/^\s*\|[\s|-]*\|\s*$/.test(text) && /-/.test(text)) {
        expect(classes).toContain('cm-table-row');
        delimiterSeen++;
      } else if (/^\s*\|\s*a\s*\|\s*b\s*\|/.test(text)) {
        expect(classes).toContain('cm-table-header');
        headerSeen++;
      } else {
        expect(classes).toContain('cm-table-row');
        rowSeen++;
      }

      expect(classes).not.toContain('cm-table-cell-band-');
      expect(classes).not.toContain('cm-fenced-code-line');
      expect(classes).not.toContain('cm-list-item');
      expect(classes).not.toContain('cm-del');

      const box = await allLines.nth(i).evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          bg: s.backgroundColor,
          borderLeftWidth: s.borderLeftWidth,
          borderTopWidth: s.borderTopWidth,
          borderBottomWidth: s.borderBottomWidth,
          paddingInlineStart: s.paddingInlineStart,
          fontSize: s.fontSize,
        };
      });
      expect(box.bg).toMatch(/rgba?\(0, ?0, ?0, ?0\)|transparent|rgb\(255/);
      expect(box.borderLeftWidth).toBe('0px');
      expect(box.borderTopWidth).toBe('0px');
      expect(box.borderBottomWidth).toBe('0px');
      expect(box.fontSize).toBe(paragraphFontSize);
      const padPx = parseFloat(box.paddingInlineStart);
      expect(padPx).toBeGreaterThan(0);
    }

    expect(headerSeen).toBe(1);
    expect(delimiterSeen).toBe(1);
    expect(rowSeen).toBe(1);
  });
});

test.describe('§6.7 Cross-cutting', () => {
  test('Cmd+A → Cmd+C is byte-identical to source doc state', async ({ page, api }) => {
    const composition = [
      '~~strikethrough~~',
      '',
      '- bullet one',
      '- bullet two with more text',
      '',
      '```typescript',
      'const x = 1;',
      '```',
      '',
      '[click][ref]',
      '',
      '[ref]: https://example.com',
      '',
      '[[SomePage]]',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');

    await seedMarkdown(api, testDocName, composition);
    await switchToSource(page);

    await page.waitForFunction(
      () => {
        const provider = window.__activeProvider;
        if (!provider?.isSynced) return false;
        const ytext = provider.document.getText('source');
        const now = ytext.length;
        const prev = (window as unknown as { __lastYTextLen?: number }).__lastYTextLen;
        const stable = (window as unknown as { __yTextStable?: number }).__yTextStable ?? 0;
        (window as unknown as { __lastYTextLen: number }).__lastYTextLen = now;
        if (prev === now) {
          (window as unknown as { __yTextStable: number }).__yTextStable = stable + 1;
          return stable + 1 >= 3;
        }
        (window as unknown as { __yTextStable: number }).__yTextStable = 0;
        return false;
      },
      null,
      { timeout: 10_000, polling: 100 },
    );

    const docState = await page.evaluate(() => {
      const provider = window.__activeProvider;
      if (!provider) throw new Error('no __activeProvider');
      const ytext = provider.document.getText('source');
      return ytext.toString();
    });

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.locator('.cm-content').focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+c');

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());

    expect(clipboard).toBe(docState);
  });
});
