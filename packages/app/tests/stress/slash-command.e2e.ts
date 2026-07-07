/**
 * Slash command menu — behavioral E2E specification.
 *
 * Describes how the slash command menu works from a user's perspective:
 * triggering, filtering, keyboard navigation, item insertion, positioning,
 * and accessibility. Each test is a behavioral statement that should remain
 * true regardless of the internal implementation.
 *
 * Requires: Playwright browsers installed. Dev server started by
 * `playwright.config.ts` `webServer` on VITE_PORT (or default 5173).
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  getSelectedItemSnapshot,
  test,
  waitForActiveProviderSynced,
  waitForSlashMenuClosed,
  waitForSlashMenuFilteredBy,
  waitForSlashMenuFirstOption,
  waitForSlashMenuOpen,
} from './_helpers';

// ---------------------------------------------------------------------------
// Helpers — thin wrappers around the editor's observable surface
// ---------------------------------------------------------------------------

async function resetEditor(_api: ApiHelpers, page: Page, docName: string) {
  // Each test creates a fresh unique doc in beforeEach; avoid extra reset/write
  // traffic here so the editor selection cannot race a document truncate.
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(
    () => document.querySelector('.ProseMirror:not(.composer-prosemirror)')?.textContent === '',
    null,
    {
      timeout: 5_000,
    },
  );
}

async function getEditorState(page: Page) {
  return page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    return {
      text: pm?.textContent ?? '',
      h1Count: pm?.querySelectorAll('h1').length ?? 0,
      h2Count: pm?.querySelectorAll('h2').length ?? 0,
      ulCount: pm?.querySelectorAll('ul').length ?? 0,
      blockquoteCount: pm?.querySelectorAll('blockquote').length ?? 0,
      tableCount: pm?.querySelectorAll('table').length ?? 0,
    };
  });
}

async function getMenuState(page: Page) {
  return page.evaluate(() => {
    const menu = document.querySelector('[role="listbox"][aria-label="Slash commands"]');
    if (!menu) return { open: false } as const;
    const items = Array.from(menu.querySelectorAll('[role="option"]'));
    const groups = Array.from(menu.querySelectorAll('[role="group"]'));
    const legends = groups.map((g) => {
      const labelledBy = g.getAttribute('aria-labelledby');
      if (labelledBy) return document.getElementById(labelledBy)?.textContent?.trim() ?? '';
      return g.getAttribute('aria-label') ?? '';
    });
    return {
      open: true,
      itemCount: items.length,
      legends,
      items: items.map((i) => ({
        text: i.textContent?.trim() ?? '',
        ariaSelected: i.getAttribute('aria-selected'),
        dataSelected: i.getAttribute('data-selected'),
      })),
    } as const;
  });
}

/** Walks up from the menu to the body-attached fixed-position popup div. */
async function getPopupInfo(page: Page) {
  return page.evaluate(() => {
    const menu = document.querySelector('[role="listbox"][aria-label="Slash commands"]');
    if (!menu) return null;
    let el: HTMLElement | null = menu as HTMLElement;
    while (el && el !== document.body) {
      if (window.getComputedStyle(el).position === 'fixed') {
        return {
          cssVar: el.style.getPropertyValue('--suggestion-menu-max-height'),
          rect: el.getBoundingClientRect().toJSON(),
        };
      }
      el = el.parentElement;
    }
    return null;
  });
}

async function getCursorRect(page: Page) {
  return page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    if (!pm) return null;
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    let node = walker.nextNode();
    while (node) {
      if (node.textContent && node.textContent.length > 0) {
        lastText = node as Text;
      }
      node = walker.nextNode();
    }
    if (!lastText?.textContent) return null;
    const len = lastText.textContent.length;
    const range = document.createRange();
    range.setStart(lastText, len - 1);
    range.setEnd(lastText, len);
    return range.getBoundingClientRect().toJSON();
  });
}

// ---------------------------------------------------------------------------
// Triggering and filtering
// ---------------------------------------------------------------------------

test.describe('slash command — triggering and filtering', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-slash-trigger-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    page.on('pageerror', (e) => {
      throw new Error(`Uncaught page error: ${e.message}`);
    });
    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  });

  test('typing / in an empty paragraph opens the command menu', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    const m = await getMenuState(page);
    expect(m.open).toBe(true);
    if (!m.open) return;
    expect(m.itemCount).toBeGreaterThan(0);
    expect(m.items[0]?.ariaSelected).toBe('true');
  });

  test('typing a query after / narrows items to those matching the query', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/heading');
    await waitForSlashMenuFilteredBy(page, 'heading');

    const m = await getMenuState(page);
    expect(m.open).toBe(true);
    if (!m.open) return;
    expect(m.items.every((i) => i.text.toLowerCase().includes('heading'))).toBe(true);
  });

  test('query matching is case-insensitive', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/HEADING');
    await waitForSlashMenuFilteredBy(page, 'heading');

    const m = await getMenuState(page);
    expect(m.open).toBe(true);
    if (!m.open) return;
    expect(m.items.every((i) => i.text.toLowerCase().includes('heading'))).toBe(true);
    await page.keyboard.press('Escape');
  });

  test('typing / after whitespace mid-line opens the menu', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('hello world ');
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(
      'hello world',
    );
    await page.keyboard.type('/bullet');
    await waitForSlashMenuFirstOption(page, 'bullet list');

    const m = await getMenuState(page);
    expect(m.open).toBe(true);
    await page.keyboard.press('Escape');
  });

  test('a query with no matches closes the menu and preserves the typed text', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/xyz');
    await waitForSlashMenuClosed(page);

    expect(await getMenuState(page).then((m) => m.open)).toBe(false);
    expect(await getEditorState(page).then((s) => s.text)).toContain('/xyz');
  });
});

// ---------------------------------------------------------------------------
// Item insertion
// ---------------------------------------------------------------------------

test.describe('slash command — item insertion', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-slash-insert-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    page.on('pageerror', (e) => {
      throw new Error(`Uncaught page error: ${e.message}`);
    });
    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  });

  test('selecting an item via Enter inserts it and removes the trigger text', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/h2');
    await waitForSlashMenuFirstOption(page, 'heading 2');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ProseMirror h2')).toHaveCount(1);

    const s = await getEditorState(page);
    expect(s.h2Count).toBe(1);
    expect(s.text).not.toContain('/');
  });

  test('Tab inserts the selected item (same as Enter)', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/h2');
    await waitForSlashMenuFirstOption(page, 'heading 2');
    await page.keyboard.press('Tab');
    await expect(page.locator('.ProseMirror h2')).toHaveCount(1);

    const s = await getEditorState(page);
    expect(s.h2Count).toBe(1);
    expect(s.text).not.toContain('/h2');
  });

  test('clicking an item with the mouse inserts it', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/quote');
    await waitForSlashMenuFirstOption(page, 'quote');

    const clicked = await page.evaluate(() => {
      const item = document.querySelector('[role="listbox"] [role="option"]');
      if (!item) return false;
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return true;
    });
    expect(clicked).toBe(true);
    await expect(page.locator('.ProseMirror blockquote')).toHaveCount(1);

    const s = await getEditorState(page);
    expect(s.blockquoteCount).toBe(1);
    expect(s.text).not.toContain('/');
  });

  test('table command inserts a table with a header row', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/table');
    await waitForSlashMenuFirstOption(page, 'table');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ProseMirror table')).toHaveCount(1);

    const info = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
      const table = pm?.querySelector('table');
      return {
        exists: !!table,
        rows: table?.querySelectorAll('tr').length ?? 0,
        hasHeader: (table?.querySelectorAll('th').length ?? 0) > 0,
      };
    });
    expect(info.exists).toBe(true);
    expect(info.rows).toBeGreaterThanOrEqual(2);
    expect(info.hasHeader).toBe(true);
  });

  test('mid-line insertion converts the paragraph and preserves prior text', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('hello world ');
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(
      'hello world',
    );
    await page.keyboard.type('/bullet');
    await waitForSlashMenuFirstOption(page, 'bullet list');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ProseMirror ul')).toHaveCount(1);

    const s = await getEditorState(page);
    expect(s.ulCount).toBe(1);
    expect(s.text).toContain('hello world');
    expect(s.text).not.toContain('/bullet');
  });

  test('rapid / then Enter inserts an item without leftover trigger text', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.press('Slash');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => {
        const s = await getEditorState(page);
        return s.h1Count + s.h2Count + s.ulCount + s.blockquoteCount + s.tableCount;
      })
      .toBeGreaterThan(0);

    const s = await getEditorState(page);
    // Some item was inserted (first item in the menu)
    expect(s.h1Count + s.h2Count + s.ulCount + s.blockquoteCount + s.tableCount).toBeGreaterThan(0);
    expect(s.text).not.toContain('/');
  });

  test('no trigger text remains in the document after any insertion', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/bulletList');
    await waitForSlashMenuFirstOption(page, 'bullet list');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ProseMirror ul')).toHaveCount(1);

    const s = await getEditorState(page);
    expect(s.text).not.toContain('/');
    expect(s.ulCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

test.describe('slash command — keyboard navigation', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-slash-nav-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    page.on('pageerror', (e) => {
      throw new Error(`Uncaught page error: ${e.message}`);
    });
    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  });

  test('arrow keys move the selection through menu items', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    // Navigate down 3 times; expect.poll on the final selection-index absorbs
    // keystroke-to-render latency without a per-iteration sleep.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowDown');
    }
    await expect.poll(() => getSelectedItemSnapshot(page).then((s) => s.index)).toBe(3);

    const m = await getMenuState(page);
    expect(m.open).toBe(true);
    if (!m.open) return;

    // Exactly one item is selected, and it's the 4th (index 3)
    const selected = m.items.filter((i) => i.dataSelected === 'true');
    expect(selected).toHaveLength(1);
    expect(m.items.findIndex((i) => i.dataSelected === 'true')).toBe(3);
    await page.keyboard.press('Escape');
  });

  test('ArrowUp moves selection upward and wraps around to the last item', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    const initial = await getSelectedItemSnapshot(page);
    // First item is selected by default (index 0). ArrowUp should wrap to the last item.
    await page.keyboard.press('ArrowUp');
    await expect
      .poll(() => getSelectedItemSnapshot(page).then((s) => s.index))
      .toBe(initial.itemCount - 1);

    const m = await getMenuState(page);
    expect(m.open).toBe(true);
    if (!m.open) return;
    const selectedIdx = m.items.findIndex((i) => i.dataSelected === 'true');
    expect(selectedIdx).toBe(m.itemCount - 1);
    await page.keyboard.press('Escape');
  });

  test('selection clamps to the last item when filtering narrows the list', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    // Navigate down 5 items (selection at index 5)
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowDown');
    }
    await expect.poll(() => getSelectedItemSnapshot(page).then((s) => s.index)).toBe(5);

    // Now type a query that narrows to fewer items than current index
    // Backspace to delete '/', then type '/h' — which should match heading items only (~3)
    await page.keyboard.press('Backspace');
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).not.toContainText('/');
    await page.keyboard.type('/heading');
    await waitForSlashMenuFilteredBy(page, 'heading');

    const m = await getMenuState(page);
    expect(m.open).toBe(true);
    if (!m.open) return;
    // Selection should be clamped to within the narrowed list, not beyond it
    const selectedIdx = m.items.findIndex((i) => i.dataSelected === 'true');
    expect(selectedIdx).toBeGreaterThanOrEqual(0);
    expect(selectedIdx).toBeLessThan(m.itemCount);
    await page.keyboard.press('Escape');
  });

  test('Escape closes the menu without inserting anything', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);
    expect(await getMenuState(page).then((m) => m.open)).toBe(true);

    await page.keyboard.press('Escape');
    await waitForSlashMenuClosed(page);

    expect(await getMenuState(page).then((m) => m.open)).toBe(false);
    // The / character remains — nothing was inserted or deleted
    expect(await getEditorState(page).then((s) => s.text)).toContain('/');
  });

  test('navigating past the last item keeps the selected item visible', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    const m = await getMenuState(page);
    if (!m.open) return;
    // Press down enough times to reach the last item
    for (let i = 0; i < m.itemCount - 1; i++) {
      await page.keyboard.press('ArrowDown');
    }
    await expect
      .poll(() => getSelectedItemSnapshot(page).then((s) => s.index))
      .toBe(m.itemCount - 1);

    const lastVisible = await page.evaluate(() => {
      const menu = document.querySelector('[role="listbox"]');
      if (!menu) return false;
      const items = menu.querySelectorAll('[role="option"]');
      const last = items[items.length - 1];
      if (!last) return false;
      const menuRect = menu.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      return lastRect.top >= menuRect.top - 1 && lastRect.bottom <= menuRect.bottom + 10;
    });
    expect(lastVisible).toBe(true);
    await page.keyboard.press('Escape');
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

test.describe('slash command — accessibility', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-slash-a11y-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    page.on('pageerror', (e) => {
      throw new Error(`Uncaught page error: ${e.message}`);
    });
    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  });

  test('the menu uses listbox role with labeled options', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    const aria = await page.evaluate(() => {
      const menu = document.querySelector('[role="listbox"]');
      if (!menu) return null;
      const opts = menu.querySelectorAll('[role="option"]');
      return {
        menuAriaLabel: menu.getAttribute('aria-label'),
        optionCount: opts.length,
        allHaveAriaSelected: Array.from(opts).every((o) => o.hasAttribute('aria-selected')),
        exactlyOneSelected:
          Array.from(opts).filter((o) => o.getAttribute('aria-selected') === 'true').length === 1,
      };
    });
    if (!aria) throw new Error('menu not rendered');
    expect(aria.menuAriaLabel).toBe('Slash commands');
    expect(aria.optionCount).toBeGreaterThan(0);
    expect(aria.allHaveAriaSelected).toBe(true);
    expect(aria.exactlyOneSelected).toBe(true);
    await page.keyboard.press('Escape');
  });

  test('aria-activedescendant references a valid option and updates on navigation', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    // Initial state: first item selected — aria-activedescendant should reference it
    const initial = await page.evaluate(() => {
      const menu = document.querySelector('[role="listbox"]');
      if (!menu) return null;
      const adId = menu.getAttribute('aria-activedescendant');
      if (!adId) return { adId: null, exists: false, isSelected: false };
      const target = document.getElementById(adId);
      return {
        adId,
        exists: !!target,
        isSelected: target?.getAttribute('aria-selected') === 'true',
      };
    });
    if (!initial) throw new Error('menu not rendered');
    expect(initial.adId).toBeTruthy();
    expect(initial.exists).toBe(true);
    expect(initial.isSelected).toBe(true);

    // Navigate down — aria-activedescendant should update to a different ID
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => getSelectedItemSnapshot(page).then((s) => s.adId))
      .not.toBe(initial.adId);

    const afterNav = await page.evaluate(() => {
      const menu = document.querySelector('[role="listbox"]');
      if (!menu) return null;
      const adId = menu.getAttribute('aria-activedescendant');
      if (!adId) return { adId: null, exists: false, isSelected: false };
      const target = document.getElementById(adId);
      return {
        adId,
        exists: !!target,
        isSelected: target?.getAttribute('aria-selected') === 'true',
      };
    });
    if (!afterNav) throw new Error('menu not rendered after navigation');
    expect(afterNav.adId).toBeTruthy();
    expect(afterNav.exists).toBe(true);
    expect(afterNav.isSelected).toBe(true);
    // The referenced ID should have changed after navigation
    expect(afterNav.adId).not.toBe(initial.adId);
    await page.keyboard.press('Escape');
  });

  test('live region announces the selected item label on navigation', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    // Initial live region should contain the first item's label
    const initialLive = await page.evaluate(() => {
      const live = document.querySelector('[role="listbox"] [aria-live="polite"]');
      return live?.textContent?.trim() ?? null;
    });
    expect(initialLive).toBeTruthy();

    // Navigate down — live region should update to the new item's label
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => getSelectedItemSnapshot(page).then((s) => s.liveText))
      .not.toBe(initialLive);

    const afterNavLive = await page.evaluate(() => {
      const live = document.querySelector('[role="listbox"] [aria-live="polite"]');
      return live?.textContent?.trim() ?? null;
    });
    expect(afterNavLive).toBeTruthy();
    expect(afterNavLive).not.toBe(initialLive);
    await page.keyboard.press('Escape');
  });

  test('items are grouped under category headers', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    const m = await getMenuState(page);
    expect(m.open).toBe(true);
    if (!m.open) return;
    // There are category headers, and they have human-readable labels
    expect(m.legends.length).toBeGreaterThan(0);
    for (const legend of m.legends) {
      expect(legend.length).toBeGreaterThan(0);
    }
    await page.keyboard.press('Escape');
  });

  test('the menu has a constrained max-height driven by available viewport space', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    const cls = await page.evaluate(() => {
      const menu = document.querySelector('[role="listbox"]');
      return {
        hasOverflow: menu?.className.includes('overflow-y-auto') ?? false,
        style: menu?.getAttribute('style') ?? '',
      };
    });
    expect(cls.hasOverflow).toBe(true);
    expect(cls.style).toContain('max-height');
    await page.keyboard.press('Escape');
  });
});

// ---------------------------------------------------------------------------
// Positioning
// ---------------------------------------------------------------------------

test.describe('slash command — menu positioning', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-slash-pos-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    page.on('pageerror', (e) => {
      throw new Error(`Uncaught page error: ${e.message}`);
    });
    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  });

  test('the menu appears just below the cursor', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    const cursor = await getCursorRect(page);
    const popup = await getPopupInfo(page);
    expect(cursor).not.toBeNull();
    expect(popup).not.toBeNull();
    if (!popup || !cursor) return;

    const gap = popup.rect.top - cursor.bottom;
    // Small positive gap (a few pixels of offset)
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(20);
  });

  test('the menu flips above the cursor when there is not enough room below', async ({
    page,
    api,
  }) => {
    await resetEditor(api, page, docName);
    // Push cursor near the bottom of the viewport
    for (let i = 0; i < 18; i++) {
      await page.keyboard.type(`line ${i}`);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    const popup = await getPopupInfo(page);
    const viewport = await page.evaluate(() => window.innerHeight);
    expect(popup).not.toBeNull();
    if (!popup) return;
    // Menu should be in the upper portion of the viewport (flipped above cursor)
    expect(popup.rect.top).toBeLessThan(viewport * 0.75);
    await page.keyboard.press('Escape');
  });

  test('the menu max-height adapts to available viewport space', async ({ page, api }) => {
    await resetEditor(api, page, docName);
    await page.keyboard.type('/');
    await waitForSlashMenuOpen(page);

    const popup = await getPopupInfo(page);
    expect(popup).not.toBeNull();
    if (!popup) return;

    // The CSS variable is set by the size middleware — its value is viewport-relative
    expect(popup.cssVar).toBeTruthy();
    expect(popup.cssVar).toMatch(/^\d+(\.\d+)?px$/);
    const maxHeightPx = parseFloat(popup.cssVar);
    const viewport = await page.evaluate(() => window.innerHeight);
    expect(maxHeightPx).toBeGreaterThan(0);
    expect(maxHeightPx).toBeLessThanOrEqual(viewport * 0.5);
    await page.keyboard.press('Escape');
  });

  // The former "menu repositions on editor scroll" test was deleted after
  // TDD review found it testing Floating-UI's `autoUpdate` contract rather
  // than any invariant we own. Scroll tracking is Floating-UI's
  // responsibility; we configure middleware + virtual element, and the
  // "menu appears just below the cursor" test above already exercises that
  // our `startAutoUpdate` wiring is live (the popup would never reveal
  // without autoUpdate's first synchronous `doPosition` resolving). The
  // deleted test also ran up against Chromium's programmatic-scroll rebound
  // — a browser-native ~150ms scroll correction that neutralized small
  // `scrollTop` deltas and produced intermittent failures under CPU
  // contention.
});
