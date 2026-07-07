/**
 * Editor / selection helpers.
 *
 * Document seeding (`createPage`, `replaceDoc`, `seedDocs`) moved to the
 * worker-scoped `api` fixture in `fixtures.ts` so each worker addresses its
 * own dev server via a closure over `baseURL` — no more ambient
 * `process.env.VITE_PORT` lookup. Consumers access those via
 * `test(async ({ api }) => ...)`.
 *
 * This file retains only page-scoped selection/editor helpers that don't
 * touch the server URL.
 */

import type { Page } from '@playwright/test';

/**
 * Press the platform select-all chord in the focused editor view and yield
 * to the browser so PM / CM6 sync their internal selection state before the
 * caller dispatches the next event. Uses a page-level double-rAF — a
 * deterministic signal that the browser has completed at least two paint
 * frames since the select-all fired.
 *
 * Uses Playwright's `ControlOrMeta` pseudo-modifier (v1.37+), which maps to
 * Meta on macOS and Control elsewhere. This matches `prosemirror-keymap`'s
 * `Mod-a` resolution — without it, CI chromium (Linux) would send Super+a,
 * which doesn't trigger PM's `selectAll` command, so `simulateCopyAndRead`
 * would return an empty MIME map.
 *
 * Replaces the ad-hoc `page.waitForTimeout(50)` frame-yield idiom; the
 * double-rAF wait is bounded (~32ms at 60fps), deterministic, and tolerates
 * the empty-doc case (empty-copy — no selection is expected) without
 * special-casing.
 *
 */
export async function selectAllAndWaitForSelection(page: Page, selector: string): Promise<void> {
  await page.focus(selector);
  await page.keyboard.press('ControlOrMeta+a');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Commit DOM focus on the active PM editor AND sync the browser's DOM
 * selection to match PM's `state.selection`. Required between
 * `page.evaluate(() => editor.chain().focus().setTextSelection(...).run())`
 * and any subsequent `page.keyboard.press(...)` whose effect must be
 * observed by PM's keymap from the freshly-set cursor position.
 *
 * Two compounding gaps this closes:
 *
 *   1. **DOM-focus deferral**: TipTap's `editor.commands.focus()` defers
 *      `view.focus()` to `requestAnimationFrame` on Chromium / Firefox
 *      (only iOS/Android/Safari run it synchronously — see `@tiptap/core`
 *      `delayedFocus`). The chain returns before the rAF fires, so the
 *      next `page.keyboard.press(...)` may land on `document.body` (the
 *      focus fallback after the prior test's editor was unmounted by
 *      `page.goto`). PM's keymap is wired to
 *      `view.dom.addEventListener('keydown', ...)`, so an event on
 *      `body` bypasses every L0/L1 handler.
 *
 *   2. **DOM-selection-not-synced**: PM's `selectionToDOM` early-returns
 *      when `editorOwnsSelection(view)` is false, and that check goes
 *      through `view.hasFocus()`. So `editor.chain().focus().setTextSelection(pos).run()`
 *      updates PM `state.selection` to the target position, but the
 *      browser's `document.getSelection()` is NOT synced to match. The
 *      next ArrowUp / ArrowRight / ... dispatches against the STALE DOM
 *      cursor position; the browser's default key-handling moves the
 *      cursor from the wrong origin, and PM's DOMObserver reads back the
 *      resulting (still wrong) cursor into PM state — the assertion sees
 *      "cursor didn't move" because the wrong-origin motion looks like a
 *      no-op or moves the cursor to an unexpected destination.
 *
 * Fix (mirrors PM's own focus path):
 *
 *   a. Call `view.focus()` (PM's `EditorView` method, NOT raw
 *      `view.dom.focus()`). PM's `view.focus()` focuses `view.dom` AND
 *      calls `selectionToDOM(view)` internally — that's the call that
 *      actually moves the browser's DOM cursor to match `editor.state.selection`.
 *
 *   b. Poll until `view.hasFocus()` is true (Chromium's `element.focus()`
 *      updates `activeElement` after a microtask tick — Playwright sends
 *      keyboard events over CDP and the focus event may not have
 *      propagated to `root.activeElement` yet). On each poll iteration,
 *      RE-INVOKE `view.focus()` so `selectionToDOM` runs again now that
 *      `editorOwnsSelection(view)` actually returns true (it checks
 *      `view.hasFocus()`).
 *
 * For programmatic cursor positions INSIDE NodeView-wrapped paragraphs
 * (e.g. inside a Callout body's `<p>`), `domAtPos` / `getSelection`
 * alignment is brittle (programmatic placement here remained flaky at
 * `--repeat-each=5`, so those cases were refactored to a real
 * `page.locator().click()` + `Home` + `waitForPmSelectionInNode('jsxComponent')`
 * pattern with a reliable contract). This helper is
 * suited to programmatic cursor placement at TOP-LEVEL textblock
 * boundaries (heading, top-level paragraph).
 *
 * Bounded by `view.hasFocus() === true`. Default upper bound 5s; DOM
 * focus events fire within ~1 rAF / 16ms in practice, but under CI
 * `workers=4` CPU contention a cold worker has been observed to exceed
 * 2s. The bound is the
 * actual observable condition, not a magic sleep.
 *
 * Category C (cursor / focus flush) per precedent #20(a).
 */
export async function focusEditor(page: Page, timeoutMs = 5_000): Promise<void> {
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    // Null editor = test fixture broke before this call (provider pool didn't
    // register one). Returning silently lets the waitForFunction below surface
    // it as a 2s TimeoutError with a stack trace pointing at the caller — a
    // better signal than throwing here would (caller is already mid-evaluate).
    if (!editor) return;
    editor.view.focus();
  });
  await page.waitForFunction(
    () => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      if (!editor.view.hasFocus()) return false;
      // Re-invoke view.focus() so PM's selectionToDOM re-runs now that
      // editorOwnsSelection(view) returns true. selectionToDOM syncs the
      // browser's DOM cursor to match editor.state.selection.
      editor.view.focus();
      return true;
    },
    null,
    { timeout: timeoutMs },
  );
}

/**
 * Wait until ProseMirror's `editor.state.selection` has an ancestor of the
 * given `nodeType` name — i.e. the cursor is INSIDE that node type per PM's
 * internal state, not merely per the DOM.
 *
 * Use this after a `click()` that should land the cursor inside a specific
 * node (tableCell, listItem, codeBlock, ...) and BEFORE the subsequent
 * `keyboard.press(...)` that reads PM state. Under `workers>1` CPU
 * contention, PM's DOMObserver can lag behind the DOM selection update by
 * tens of ms — a double-rAF yield reports "frame painted" but PM's state
 * is still stale. The TipTap table extension's Tab handler reads
 * `editor.state.selection`, sees no tableCell ancestor, calls
 * `goToNextCell()` → returns false → falls through to `addRowAfter()`
 * which creates an empty trailing row (the exact
 * flake that surfaced under full-suite `workers=4`).
 *
 * Requires `window.__activeEditor` exposure from `DocumentContext.tsx`
 * (DEV-gated — tree-shaken from production bundles). Category C per
 * precedent #20(a).
 */
export async function waitForPmSelectionInNode(
  page: Page,
  nodeType: string,
  timeoutMs = 5_000,
): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      const $from = editor.state.selection.$from;
      for (let d = $from.depth; d >= 0; d--) {
        if ($from.node(d).type.name === expected) return true;
      }
      return false;
    },
    nodeType,
    { timeout: timeoutMs },
  );
}
