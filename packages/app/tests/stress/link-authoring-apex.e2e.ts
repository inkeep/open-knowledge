/**
 * Apex E2E for the link-authoring feature — the release gate for the
 * cross-writer hazard and the ⌘K dual-role contract.
 *
 * Four concerns, each proven in the real app rather than at a unit rung:
 *
 *  1. Cross-writer safety across two live clients. A boundary-terminated URL
 *     that reaches a client via CRDT sync (another writer's content) is NEVER
 *     linkified; only a client's OWN locally-typed URL + boundary converts.
 *     This is the origin guard (ySyncPluginKey) observed end-to-end.
 *  2. Cross-writer safety for a pooled/backgrounded editor. A hidden Activity's
 *     editor still has a live provider and receives remote writes; it must
 *     never linkify them (origin guard + active-editor gate).
 *  3. ⌘K routing matrix: non-empty selection → link popover; collapsed caret →
 *     palette; caret inside a link → chip edit surface; source pane → palette;
 *     ⌘⇧K → NOT the palette (the exact-⌘K narrowing).
 *  4. Clipboard pre-fill degrades silently: with clipboard-read withheld
 *     (real permission gate), the popover opens empty and stays functional.
 *
 * Byte-shape oracles live in link-authoring-bytes.e2e.ts; this file asserts
 * link-mark presence/absence and which UI surface a shortcut routes to.
 *
 * Run:
 *   cd packages/app && bunx playwright test tests/stress/link-authoring-apex.e2e.ts
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { Node as PMNode } from '@tiptap/pm/model';
import { expect, focusEditor, selectText, test, waitForActiveProviderSynced } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const LINK_CHIP = `${EDITOR} span[data-link]`;
const PALETTE = '[cmdk-root]';

/** Does the active editor's doc carry any link mark? */
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

// ───────────────────────────────────────────────────────────────────────────
// Cross-writer: two live clients — a synced URL is never linkified by the receiver
// ───────────────────────────────────────────────────────────────────────────

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

      // Client A LIVE-TYPES a GFM-shaped URL with NO trailing boundary key.
      // Live typing (not a markdown/agent write, which would parse the bare URL
      // into a link) leaves it as plain text: A's own plugin needs a boundary
      // to fire, and none was typed. The plain text syncs to B as another
      // writer's content.
      await pageA.locator(EDITOR).click();
      await pageA.keyboard.type('https://a-side.com');
      await waitForYTextToContain(pageB, 'a-side.com');

      // Neither client linkified A's boundary-less URL — B must not convert
      // content that arrived via CRDT sync, and A never typed a boundary.
      expect(await pmHasLink(pageA)).toBe(false);
      expect(await pmHasLink(pageB)).toBe(false);
      await expect(pageA.locator(LINK_CHIP)).toHaveCount(0);
      await expect(pageB.locator(LINK_CHIP)).toHaveCount(0);

      // B types its OWN URL + space at the START of the doc — its boundary
      // (the trailing space) lands after B's token, never adjacent to A's URL,
      // so only B's token converts. (A boundary typed right after A's URL would
      // legitimately convert it too: that is B's own local edit completing the
      // token, not a cross-writer linkification.)
      await pageB.locator(EDITOR).click();
      await pageB.evaluate(() => window.__activeEditor?.commands.focus('start'));
      await pageB.keyboard.type('https://b-own.com ');

      await pageB.waitForFunction(
        () =>
          JSON.stringify(window.__activeEditor?.state.doc.toJSON() ?? {}).includes('"type":"link"'),
        null,
        { timeout: 5_000 },
      );

      // Exactly one link on B: its own URL. A's synced URL is still plain.
      await expect(pageB.locator(`${LINK_CHIP}[aria-label="Link: https://b-own.com"]`)).toHaveCount(
        1,
      );
      await expect(pageB.locator(LINK_CHIP)).toHaveCount(1);

      // The mark syncs back to A; A shows exactly the same one link (B's), and
      // still nothing on its own boundary-less URL.
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

// ───────────────────────────────────────────────────────────────────────────
// A pooled/backgrounded editor never linkifies remote writes
// ───────────────────────────────────────────────────────────────────────────

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

    // Context H holds X, then navigates to Y — X's editor flips to
    // <Activity mode="hidden"> but keeps a live provider in the pool.
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

      // Context M opens X (foreground) and live-types a boundary-less URL. It
      // stays plain (no boundary → M's own plugin doesn't fire) and syncs into
      // X's Y.Doc, reaching H's HIDDEN X editor while it is backgrounded.
      await pageM.goto(`/#/${docX}`);
      await pageM.waitForFunction(() => Boolean(window.__activeProvider), null, {
        timeout: 15_000,
      });
      await pageM.waitForSelector(EDITOR);
      await pageM.locator(EDITOR).click();
      await pageM.keyboard.type('https://while-hidden.com');
      await waitForYTextToContain(pageM, 'while-hidden.com');

      // Deterministic delivery signal: poll H's HIDDEN pooled doc (via the
      // provider pool's read-only peek) until the peer's URL reaches it while
      // X is still backgrounded — the exact window the active-editor gate
      // must hold through. Only then return to X.
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

      // The URL is present but the hidden editor never linkified it.
      expect(await pmHasLink(pageH)).toBe(false);
      await expect(pageH.locator(LINK_CHIP)).toHaveCount(0);
    } finally {
      await ctxH.close();
      await ctxM.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ⌘K routing matrix
// ───────────────────────────────────────────────────────────────────────────

test.describe('apex — ⌘K dual-role routing', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-link-apex-cmdk-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await page.waitForSelector(EDITOR);
    // Seed plain text (for selection / collapsed-caret cases) plus an existing
    // link (for the caret-inside-link case).
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

    // Keyboard contract: the input takes focus on open (the popover lives in
    // the floating bubble menu, which is unfocusable until positioned — the
    // app retries until focus lands). Then two-stage Escape per the combobox
    // convention: the first dismisses the path-suggestion panel, the second
    // closes the popover and returns focus to the editor.
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
    // Caret inside "often" — plain text, not a link.
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
    // Collapse the caret inside the link mark's range.
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

    // Condition-based negative proof (no wall-clock wait): exact ⌘K on the
    // same keystroke pipeline DOES open the palette. That positive signal
    // confirms key handling processed events after the ⌘⇧K press — if ⌘⇧K
    // had opened (or toggled) the palette, this visibility wait would fail.
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

// ───────────────────────────────────────────────────────────────────────────
// Clipboard pre-fill degrades silently under permission denial
// ───────────────────────────────────────────────────────────────────────────

test.describe('apex — clipboard pre-fill under real permission denial', () => {
  test('with clipboard-read withheld, the popover opens empty and stays functional', async ({
    browser,
    api,
    baseURL,
  }) => {
    // A fresh context with NO permissions granted — navigator.clipboard.readText
    // rejects, exercising the real gate rather than a stub.
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
      // Denial degraded to an empty input — no error surfaced, no pre-fill.
      await expect(input).toHaveValue('');

      // Still functional: typing a URL and applying it creates the link.
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
