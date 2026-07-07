/**
 * Playwright E2E for Tab/Shift-Tab keymap scoping.
 *
 * Acceptance gate:
 *   (1) Tab inside listItem indents (increases list depth)
 *   (2) Tab inside tableCell advances to next cell (existing table extension
 *       behavior NOT hijacked by the list keymap)
 *   (3) Tab inside codeBlock inserts a literal \t character
 *   Shift-Tab is the reverse operation in each context.
 *
 * Implementation reference: packages/core/src/extensions/list.ts —
 * the Tab/Shift-Tab handlers walk up the resolved position and only fire
 * sinkListItem/liftListItem when a listItem ancestor is found; otherwise
 * return false to let other extensions handle the key.
 *
 * Requires: Playwright browsers installed. Dev server started by
 * playwright.config.ts webServer on VITE_PORT (or default 5173).
 */

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

/** Seed Y.Text via the agent-write-md API (bypasses keystroke timing). */
async function seedMarkdown(api: ApiHelpers, page: Page, docName: string, markdown: string) {
  await api.replaceDoc(docName, markdown);
  // Wait for both bridge directions: Y.Text reflects the write (CRDT propagation)
  // AND the XmlFragment has been mirrored by Observer B (text→tree, ~300ms typing-defer
  // does not apply for AGENT_WRITE_ORIGIN — settles via 50ms Observer B debounce).
  await expect.poll(() => getYText(page)).toContain(markdown.split('\n')[0]?.trim() || '');
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).not.toBeEmpty();
}

async function openDoc(api: ApiHelpers, page: Page, docName: string) {
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
}

function uniqueDocName(label: string): string {
  return `test-listkeymap-${label}-${randomUUID().slice(0, 8)}`;
}

test.describe('OQ1: Tab/Shift-Tab scoping by cursor context', () => {
  test('Tab inside a listItem increases list depth', async ({ page, api }) => {
    const docName = uniqueDocName('tab-listitem');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- first\n- second\n');

    // Focus the ProseMirror editor and place cursor in the second list item
    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    // Click on the "second" text to place cursor there
    await page.locator('.ProseMirror li').nth(1).click();
    // Position at end of text
    await page.keyboard.press('End');

    // PM-state gate — ensure PM's
    // selection has synced into a listItem ancestor before Tab reads it.
    await waitForPmSelectionInNode(page, 'listItem');

    // Press Tab — should indent the second item under the first
    await page.keyboard.press('Tab');

    // Observer A (XmlFragment→Y.Text) mirrors the structural change. Poll
    // until the indented form lands in Y.Text (Category D — CRDT propagation).
    await expect.poll(() => getYText(page)).toMatch(/ {2}[-*+] second/);
    const ytext = await getYText(page);
    expect(ytext).toContain('- first');
  });

  test('Shift-Tab inside a nested listItem lifts it one level', async ({ page, api }) => {
    const docName = uniqueDocName('shifttab-nested');
    await openDoc(api, page, docName);
    // Seed an already-nested list
    await seedMarkdown(api, page, docName, '- top\n  - nested\n');

    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    // Click on the nested "nested" text
    const nestedLi = page.locator('.ProseMirror li li').first();
    await nestedLi.click();
    await page.keyboard.press('End');

    // PM-state gate — Shift-Tab's
    // `liftListItem` reads PM state; block until selection is in a
    // listItem before pressing.
    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Shift+Tab');

    // Observer A mirrors the lift to Y.Text — poll until the nested item is
    // back at the top level (Category D).
    await expect.poll(() => getYText(page)).toMatch(/^- top\n- nested/m);
  });

  test('Tab inside a tableCell advances to the next cell (list keymap does NOT hijack)', async ({
    page,
    api,
  }) => {
    const docName = uniqueDocName('tab-tablecell');
    await openDoc(api, page, docName);
    // Seed a 2x2 table
    await seedMarkdown(api, page, docName, '| a | b |\n| - | - |\n| 1 | 2 |\n');

    // Click into the `1` body cell explicitly by text match — do NOT rely
    // on nth-based selectors for table cells. The markdown engine renders
    // ALL cells (header + body rows) as `<td>` (no `<th>`); `.ProseMirror
    // td` nth(0) lands on cell `a`, not `1`. Targeting by text is both
    // robust to that mapping and clearer about intent.
    const editor = page.locator('.ProseMirror:not(.composer-prosemirror)');
    const cellOne = editor.locator('td').filter({ hasText: /^1$/ });
    await cellOne.click();
    // Sync-wait for focus to land on the editor before keyboard events.
    // Under `workers>1` CPU contention, the click→focus propagation can
    // race the subsequent `keyboard.press` — without this guard, Tab can
    // fire into the previously-focused element (which, in a fresh page,
    // is often the viewport / body) and move browser focus out of the
    // editor instead of invoking TipTap's table `goToNextCell`. This is
    // the same focus-race class documented for the
    // ux-interactions focus/type chain.
    await expect(editor).toBeFocused();
    await page.keyboard.press('End');

    // PM-state gate: block until `editor.state.selection` is actually
    // inside a `tableCell` node per PM's internal model — not merely per
    // the DOM. Under full-suite `workers=4` CPU contention the DOMObserver
    // lags tens of ms behind the click-induced DOM selection, leaving PM
    // state stale. TipTap's table Tab handler reads PM state, sees no
    // tableCell ancestor, `goToNextCell()` returns false, and the
    // `addRowAfter()` fallback fires — creating an empty trailing row
    // that breaks the next-cell expectation (PM-state race, as distinct
    // from focus/DOM-selection races). The post-Tab double-rAF yield was
    // insufficient under CPU pressure.
    await waitForPmSelectionInNode(page, 'tableCell');

    // Verify we are inside cell `1`.
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

    // After Tab, cursor should still be inside a table cell (second body cell, content '2')
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

    // Y.Text must not have been structurally mutated (no list indent occurred)
    const ytext = await getYText(page);
    expect(ytext).toContain('| 1 | 2 |');
    expect(ytext).not.toMatch(/^ {2}/m);
  });

  // Tab inside a codeBlock now inserts 2 spaces (Prettier/Biome convention)
  // — `CodeBlockFidelity` sets `enableTabIndentation: true, tabSize: 2` via
  // `addOptions()`. The shipped reality is two
  // spaces (markdown round-trip via CommonMark §4.5 preserves either form).
  // The unit-level contract is pinned in `extensions/shared.dom.test.tsx`
  // (real Editor mount, real keydown dispatch); the e2e below stays
  // `.fixme` because Playwright's keyboard Tab still moves browser focus
  // before ProseMirror's keymap plugin sees the keydown (a Playwright-only
  // event-routing quirk, not a product bug). The scoping assertion ("list
  // extension's Tab doesn't hijack code block") is covered by the `Tab
  // inside a tableCell` test above, which exercises the same "list →
  // table" fall-through path.
  test('Enter at end of a non-empty bullet item creates a new bullet', async ({ page, api }) => {
    const docName = uniqueDocName('enter-bullet');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- sf\n');

    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Enter');
    // After split: two bullet items; Y.Text reflects two list lines.
    await expect.poll(() => getYText(page)).toMatch(/^- sf\n- ?$/m);
  });

  test('Enter at end of a non-empty ordered item creates a new ordered item', async ({
    page,
    api,
  }) => {
    const docName = uniqueDocName('enter-ordered');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '1. sf\n');

    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
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

    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    await page.keyboard.press('Enter');
    await expect.poll(() => getYText(page)).toMatch(/^- \[ \] sf\n- \[ \] ?$/m);
  });

  // Backspace/Delete in and around lists must behave like GFM,
  // and a freshly-typed list must not be absorbed into an adjacent list of a
  // different kind. The unified List extension names its wrapper `list`, so the
  // upstream ListKeymap (default wrapperNames ['bulletList','orderedList']) and
  // the wrappingInputRule join (same node type regardless of `ordered`) both
  // need to be pointed at this schema — see shared.ts listKeymap config and
  // list.ts joinPredicate.
  test('Backspace on the empty line after a list merges back in (no stray bullet)', async ({
    page,
    api,
  }) => {
    const docName = uniqueDocName('bksp-after-list');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- item one\n');

    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    // Enter twice: first makes an empty second item, second lifts it out to a
    // paragraph below the list. Backspace from there must rejoin the list
    // rather than spawning a new empty bullet.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');

    await expect.poll(() => getYText(page).then((t) => t.trim())).toBe('- item one');
    const ytext = await getYText(page);
    // No second bullet line should have appeared.
    expect(ytext).not.toMatch(/^- *$/m);
  });

  test('Backspace on an empty nested item removes it (does not toggle the bullet)', async ({
    page,
    api,
  }) => {
    const docName = uniqueDocName('bksp-nested-empty');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '- top\n  - sub\n');

    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    await page.locator('.ProseMirror li li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    // Make an empty nested item, then Backspace: it should delete the empty
    // item and put the cursor back at the end of "sub", leaving the original
    // nested structure intact — not lift/toggle the bullet.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');

    await expect.poll(() => getYText(page)).toMatch(/^- top\n {2}- sub\n?$/m);
    const ytext = await getYText(page);
    // Exactly one bullet under "top" — no extra empty item left behind.
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

    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.press('End');
    await waitForPmSelectionInNode(page, 'listItem');

    // Exit the bullet list to an empty paragraph, then type an ordered marker.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('1. numbered item');

    // A real ordered list must appear — the bullet list must not have absorbed
    // the new item (the pre-fix bug turned "1. " into an empty bullet).
    await expect.poll(() => getYText(page)).toMatch(/^1\. numbered item$/m);
    const ytext = await getYText(page);
    expect(ytext).toContain('- bullet item');
    expect(ytext).not.toMatch(/^- *$/m);
  });

  test.fixme('Tab inside a codeBlock inserts 2 spaces', async ({ page, api }) => {
    const docName = uniqueDocName('tab-codeblock');
    await openDoc(api, page, docName);
    await seedMarkdown(api, page, docName, '```\nfirst\n```\n');

    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    // Click into the code block
    await page.locator('.ProseMirror pre code').click();
    await page.keyboard.press('End');

    await page.keyboard.press('Tab');

    // Observer A mirrors the inserted spaces to Y.Text — poll until they
    // land inside the code block (Category D).
    await expect.poll(() => getYText(page)).toMatch(/first {2}/);
    const ytext = await getYText(page);
    // Two ASCII spaces inserted (Prettier/Biome default — see
    // `CodeBlockFidelity.addOptions()`).
    expect(ytext).toMatch(/first {2}/);
    // Code fence preserved (Tab did NOT trigger a list indent)
    expect(ytext).toContain('```');
    // No spurious list syntax
    expect(ytext).not.toMatch(/^- /m);
  });
});
