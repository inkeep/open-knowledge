/**
 * Editor mode persistence E2E.
 *
 * Covers the user-observable behavior of the editor-mode-persistence feature
 * under the "per-tab session, load-time-only reads" design: refresh preserves
 * persisted mode, new tab inherits persisted mode, open tabs are independent
 * until reload, new doc honors pref, invalid value falls back to default,
 * RAW_MDX_NAV_EVENT stays session-only, and FOUC-free first paint.
 *
 * Implementation under test:
 *   - packages/app/index.html (inline FOUC script)
 *   - packages/app/src/editor/use-editor-mode.ts (hook)
 *   - packages/app/src/components/EditorPane.tsx integration
 *
 * Multi-page tests use ONE BrowserContext with multiple pages via
 * `context.newPage()` — separate contexts do NOT share localStorage.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

const STORAGE_KEY = 'ok-editor-mode-v1';

/**
 * Both `.cm-editor` (CodeMirror) and `.ProseMirror` (TipTap) are always
 * mounted in the DOM — the mode-swap is a CSS class flip on the wrapper
 * (`.ok-mode-hidden` → `content-visibility:hidden`). Playwright's
 * `toBeVisible` correctly reports `content-visibility:hidden` elements as
 * hidden because their layout box collapses to 0×0, so we can assert on
 * the editor subtree directly.
 */
async function expectSourceMounted(page: Page, timeout = 10_000): Promise<void> {
  await expect(page.locator('.cm-editor').first()).toBeVisible({ timeout });
}

async function expectWysiwygMounted(page: Page, timeout = 10_000): Promise<void> {
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
    timeout,
  });
}

test.describe('editor-mode-persistence — SPEC §8.3', () => {
  // ── refresh preserves persisted mode ─────────────────────────────
  test('T1: refresh preserves persisted mode', async ({ page, api }) => {
    const docName = `test-emp-t1-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);

    // User action: click Markdown toggle → persists to localStorage.
    await sourceToggle(page).click();
    await expectSourceMounted(page);

    // Confirm persistence landed in localStorage.
    const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(stored).toBe('source');

    // Hard refresh.
    await page.reload();
    await waitForProvider(page);

    // Source editor is visible on the reloaded page — no FOUC flash to
    // WYSIWYG. The FOUC script preloads window.__OK_EDITOR_MODE__ before
    // React mounts so the initial useState value is correct.
    await expectSourceMounted(page);
    const postReloadGlobal = await page.evaluate(
      () => (window as unknown as { __OK_EDITOR_MODE__?: unknown }).__OK_EDITOR_MODE__,
    );
    expect(postReloadGlobal).toBe('source');
  });

  // ── new tab inherits persisted mode ──────────────────────────────
  test('T2: new tab inherits persisted mode', async ({ context, page, api }) => {
    const docName = `test-emp-t2-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);
    await sourceToggle(page).click();
    await expectSourceMounted(page);

    // Second page in the SAME BrowserContext — localStorage is shared at
    // the context level (separate contexts would NOT share).
    const pageB = await context.newPage();
    await pageB.goto(`/#/${docName}`);
    await waitForProvider(pageB);

    // Page B opens in Source — the FOUC script read the shared localStorage.
    await expectSourceMounted(pageB);
  });

  // ── open tabs are independent until reload ───────────────────────
  //
  // Core invariant of the per-tab-session design: a mode flip in one tab
  // does NOT propagate to another open tab. The persisted value is read
  // only at load — so a subsequent tab reload picks it up, but a plain
  // focus return on an already-open tab does not. This test asserts both
  // halves of the invariant from the user's perspective:
  // (a) flip in A + focus return on B leaves B unchanged,
  // (b) reload B picks up the new value.
  //
  // Explicit `window.focus` dispatch guards against a focus-listener
  // regression — if any future contributor re-adds a focus listener
  // that re-reads localStorage, this test fails on the (a) half.
  test('T3: open tabs are independent until reload', async ({ context, page, api }) => {
    const docName = `test-emp-t3-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);

    const pageB = await context.newPage();
    await pageB.goto(`/#/${docName}`);
    await waitForProvider(pageB);
    await expectWysiwygMounted(pageB);

    // Page A: flip to Source. localStorage now holds 'source'.
    await page.bringToFront();
    await sourceToggle(page).click();
    await expectSourceMounted(page);

    // Page B: bring to front + explicit `focus` dispatch. The old design
    // would have picked up the persisted change here; the new design
    // explicitly does NOT. Page B must stay in WYSIWYG.
    await pageB.bringToFront();
    await pageB.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await expectWysiwygMounted(pageB);
    await expect(pageB.locator('.cm-editor').first()).toBeHidden({ timeout: 2_000 });

    // Page B: reload — FOUC script re-reads localStorage on mount. The
    // persisted value ('source') now applies.
    await pageB.reload();
    await waitForProvider(pageB);
    await expectSourceMounted(pageB);
  });

  // ── new doc honors persisted mode ────────────────────────────────
  test('T4: new doc honors persisted mode', async ({ page, api }) => {
    const seedDocName = `test-emp-t4a-${randomUUID().slice(0, 8)}`;
    const newDocName = `test-emp-t4b-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${seedDocName}.md`);
    await page.goto(`/#/${seedDocName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);

    // Set persistedMode = 'source'.
    await sourceToggle(page).click();
    await expectSourceMounted(page);

    // Create + navigate to a fresh doc — same BrowserContext, same
    // localStorage, same persisted pref.
    await api.createPage(`${newDocName}.md`);
    await page.goto(`/#/${newDocName}`);
    await waitForProvider(page);

    // New doc opens in Source (not default WYSIWYG).
    await expectSourceMounted(page);
  });

  // ── invalid localStorage value falls back to WYSIWYG default ─────
  test('T6: invalid localStorage value falls back to default', async ({ context, page, api }) => {
    const docName = `test-emp-t6-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    // Pre-populate localStorage with garbage BEFORE the page loads. Both
    // the FOUC inline script and the hook's readInitialMode must validate
    // the value and fall back to 'wysiwyg' instead of accepting the raw
    // string.
    await context.addInitScript((key) => {
      try {
        localStorage.setItem(key, 'garbage-from-manual-tampering-or-old-schema');
      } catch {
        // ignore in contexts where storage is not writable
      }
    }, STORAGE_KEY);

    await page.goto(`/#/${docName}`);
    await waitForProvider(page);

    // Editor loads in WYSIWYG (default fallback). No crash.
    await expectWysiwygMounted(page);
    const globalAfterLoad = await page.evaluate(
      () => (window as unknown as { __OK_EDITOR_MODE__?: unknown }).__OK_EDITOR_MODE__,
    );
    expect(globalAfterLoad).toBe('wysiwyg');
  });

  // ── RAW_MDX_NAV_EVENT (tool-forced source flip) stays session-only ─
  //
  // Invariant: tool-driven source flips (dispatched via `RAW_MDX_NAV_EVENT`
  // when a user clicks a broken MDX fallback node) change the session-local
  // editor mode but MUST NOT persist to localStorage — the flip is
  // system-forced, not user intent, and persisting it would silently
  // overwrite the user's global preference.
  //
  // Guards against a DRY-minded future refactor that merges
  // `handleModeChange` and the RAW_MDX_NAV handler through one helper (a
  // reasonable instinct). The code comment in EditorPane.tsx documents the
  // asymmetry; this test enforces it.
  test('T9: RAW_MDX_NAV_EVENT flips source mode WITHOUT persisting (FR-6 / §7.5)', async ({
    page,
    api,
  }) => {
    const docName = `test-emp-t9-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await expectWysiwygMounted(page);

    // localStorage starts empty — user is a first-time visitor.
    const preFlipStored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(preFlipStored).toBe(null);

    // Dispatch the tool-forced event. `RAW_MDX_NAV_EVENT` is the same
    // string constant as `packages/app/src/editor/extensions/raw-mdx-nav-event.ts`
    // — inlined here to avoid importing app-src into the Playwright runner.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('raw-mdx-nav', { detail: { offset: 0 } }));
    });

    // Session flips to Source via `setEditorMode('source')`.
    await expectSourceMounted(page);

    // localStorage is UNCHANGED — the tool flip did not persist.
    const postFlipStored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(postFlipStored).toBe(null);

    // Reload the page — on a fresh mount, the tool's session-only flip is
    // gone and the editor returns to the default WYSIWYG (not Source).
    // This is the load-bearing assertion: persisting a tool flip would
    // make Source stick across reloads.
    await page.reload();
    await waitForProvider(page);
    await expectWysiwygMounted(page);
  });

  // ── FOUC — window global set before first paint, Source DOM on ───
  // ── first frame, WYSIWYG DOM absent ──
  test('T8: FOUC-free first paint when persisted=source', async ({ context, page, api }) => {
    const docName = `test-emp-t8-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    // Preseed localStorage BEFORE the page's scripts run — simulates a
    // returning user whose last session persisted Source.
    await context.addInitScript((key) => {
      try {
        localStorage.setItem(key, 'source');
      } catch {
        // ignore
      }
    }, STORAGE_KEY);

    await page.goto(`/#/${docName}`);

    // The inline FOUC script in index.html runs BEFORE any module
    // script. By the time module scripts execute (and thus by the time
    // we can query DOM), window.__OK_EDITOR_MODE__ must already be set.
    const globalBeforeEditor = await page.evaluate(
      () => (window as unknown as { __OK_EDITOR_MODE__?: unknown }).__OK_EDITOR_MODE__,
    );
    expect(globalBeforeEditor).toBe('source');

    // Wait for provider + first render.
    await waitForProvider(page);

    // Source editor mounted; TipTap/ProseMirror subtree is NOT visible.
    // If FOUC were broken, the WYSIWYG subtree would briefly mount on
    // the first frame before the user's pref was applied.
    await expectSourceMounted(page);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeHidden({
      timeout: 2_000,
    });
  });
});
