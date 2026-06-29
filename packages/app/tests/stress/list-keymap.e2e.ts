import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  test,
  waitForPmSelectionInNode,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

async function getYText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

async function seedMarkdown(api: ApiHelpers, page: Page, docName: string, markdown: string) {
  await api.replaceDoc(docName, markdown);
  await expect.poll(() => getYText(page)).toContain(markdown.split('\n')[0]?.trim() || '');
  await expect(page.locator('.ProseMirror')).not.toBeEmpty();
}

async function openDoc(api: ApiHelpers, page: Page, docName: string) {
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror');
}

function uniqueDocName(label: string): string {
  return `test-listkeymap-${label}-${randomUUID().slice(0, 8)}`;
}

test.describe('OQ1: Tab/Shift-Tab scoping by cursor context', () => {
  test('Tab inside a listItem increases list depth', async ({ page, api }) => {
    const docName = uniqueDocName('tab-listitem');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- first\n- second\n');

    await page.locator('.ProseMirror').focus();
    await page.locator('.ProseMirror li').nth(1).click();
    await page.keyboard.press('End');

    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Tab');

    await expect.poll(() => getYText(page)).toMatch(/ {2}[-*+] second/);
    const ytext = await getYText(page);
    expect(ytext).toContain('- first');
  });

  test('Shift-Tab inside a nested listItem lifts it one level', async ({ page, api }) => {
    const docName = uniqueDocName('shifttab-nested');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- top\n  - nested\n');

    await page.locator('.ProseMirror').focus();
    const nestedLi = page.locator('.ProseMirror li li').first();
    await nestedLi.click();
    await page.keyboard.press('End');

    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Shift+Tab');

    await expect.poll(() => getYText(page)).toMatch(/^- top\n- nested/m);
  });

  test('Tab inside a tableCell advances to the next cell (list keymap does NOT hijack)', async ({
    page,
    api,
  }) => {
    const docName = uniqueDocName('tab-tablecell');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '| a | b |\n| - | - |\n| 1 | 2 |\n');

    const editor = page.locator('.ProseMirror');
    const cellOne = editor.locator('td').filter({ hasText: /^1$/ });
    await cellOne.click();
    await expect(editor).toBeFocused();
    await page.keyboard.press('End');

    await waitForPmSelectionInNode(page, 'tableCell');

    const cellBeforeText = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      let el: Node | null = sel.anchorNode;
      while (el) {
        if (el.nodeType === 1 && (el as Element).matches('td,th')) {
          return (el as Element).textContent?.trim() ?? '';
        }
        el = el.parentNode;
      }
      return null;
    });
    expect(cellBeforeText).toBe('1');

    await editor.press('Tab');

    await expect
      .poll(() =>
        page.evaluate(() => {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return null;
          let el: Node | null = sel.anchorNode;
          while (el) {
            if (el.nodeType === 1 && (el as Element).matches('td,th')) {
              return (el as Element).textContent?.trim() ?? '';
            }
            el = el.parentNode;
          }
          return null;
        }),
      )
      .toBe('2');

    const stillInTable = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      let el: Node | null = sel.anchorNode;
      while (el) {
        if (el.nodeType === 1 && (el as Element).matches('td,th')) return true;
        el = el.parentNode;
      }
      return false;
    });
    expect(stillInTable).toBe(true);

    const ytext = await getYText(page);
    expect(ytext).toContain('| 1 | 2 |');
    expect(ytext).not.toMatch(/^ {2}/m);
  });

  test('Enter at end of a non-empty bullet item creates a new bullet', async ({ page, api }) => {
    const docName = uniqueDocName('enter-bullet');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- sf\n');

    await page.locator('.ProseMirror').focus();
    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Enter');
    await expect.poll(() => getYText(page)).toMatch(/^- sf\n- ?$/m);
  });

  test('Enter at end of a non-empty ordered item creates a new ordered item', async ({
    page,
    api,
  }) => {
    const docName = uniqueDocName('enter-ordered');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '1. sf\n');

    await page.locator('.ProseMirror').focus();
    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Enter');
    await expect.poll(() => getYText(page)).toMatch(/^1\. sf\n2\. ?$/m);
  });

  test('Enter at end of a task item creates a new task item', async ({ page, api }) => {
    const docName = uniqueDocName('enter-task');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- [ ] sf\n');

    await page.locator('.ProseMirror').focus();
    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Enter');
    await expect.poll(() => getYText(page)).toMatch(/^- \[ \] sf\n- \[ \] ?$/m);
  });

  test('Backspace on the empty line after a list merges back in (no stray bullet)', async ({
    page,
    api,
  }) => {
    const docName = uniqueDocName('bksp-after-list');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- item one\n');

    await page.locator('.ProseMirror').focus();
    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');

    await expect.poll(() => getYText(page).then((t) => t.trim())).toBe('- item one');
    const ytext = await getYText(page);
    expect(ytext).not.toMatch(/^- *$/m);
  });

  test('Backspace on an empty nested item removes it (does not toggle the bullet)', async ({
    page,
    api,
  }) => {
    const docName = uniqueDocName('bksp-nested-empty');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- top\n  - sub\n');

    await page.locator('.ProseMirror').focus();
    await page.locator('.ProseMirror li li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');

    await expect.poll(() => getYText(page)).toMatch(/^- top\n {2}- sub\n?$/m);
    const ytext = await getYText(page);
    expect(ytext.match(/- sub/g)?.length).toBe(1);
    expect(ytext).not.toMatch(/- *\n {2}- *\n {2}- /);
  });

  test('Typing "1. " below a bullet list starts a numbered list, not another bullet', async ({
    page,
    api,
  }) => {
    const docName = uniqueDocName('ordered-after-bullet');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- bullet item\n');

    await page.locator('.ProseMirror').focus();
    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('1. numbered item');

    await expect.poll(() => getYText(page)).toMatch(/^1\. numbered item$/m);
    const ytext = await getYText(page);
    expect(ytext).toContain('- bullet item');
    expect(ytext).not.toMatch(/^- *$/m);
  });

  test.fixme('Tab inside a codeBlock inserts 2 spaces', async ({ page, api }) => {
    const docName = uniqueDocName('tab-codeblock');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '```\nfirst\n```\n');

    await page.locator('.ProseMirror').focus();
    await page.locator('.ProseMirror pre code').click();
    await page.keyboard.press('End');

    await page.keyboard.press('Tab');

    await expect.poll(() => getYText(page)).toMatch(/first {2}/);
    const ytext = await getYText(page);
    expect(ytext).toMatch(/first {2}/);
    expect(ytext).toContain('```');
    expect(ytext).not.toMatch(/^- /m);
  });
});
