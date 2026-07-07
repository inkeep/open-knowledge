/**
 * JSX halo semantics — Playwright E2E.
 *
 * Pins the observable behaviors that prove `data-selected` paints only for
 * actual NodeSelection-on-this-wrapper. TextSelection with `$from` inside the
 * wrapper's content hole no longer paints the full halo; the wrapper's
 * intrinsic visual identity (Callout background, Accordion <details> chrome)
 * carries the "cursor is here, typing mode" cue.
 *
 *   TextSelection inside a Callout body → `data-selected` unset,
 *          `::after` opacity = 0 (no halo paint).
 *   Grip-click on the Callout → NodeSelection on the
 *          wrapper, `data-selected="true"`, `::after` opacity = 1.
 *   Nested Callout>Accordion, NodeSelect the inner Accordion;
 *          outer Callout gets `data-has-child-selected="true"` AND
 *          `data-selected` unset. Pins the `hasChildSelected` refactor
 *          that swapped the non-leaf guard from `!isInnermostSelected` to
 *          `!isInnermostInChain` — under TextSelection-inside (where
 *          isInnermostSelected is now false on the chain leaf), the OLD
 *          guard would have promoted the chain leaf to "its own ancestor"
 *          (visible later when nested Cards/Tabs/Steps ship), but the new
 *          guard short-circuits via `isInnermostInChain`.
 *   TextSelection inside a Callout body (chain leaf is the
 *          Callout) → `data-has-child-selected` is unset on the Callout.
 *          Confirms `isInnermostInChain` fires.
 *   Aria-live region updates for both TextSelection-inside (no halo
 *          now) AND grip-click NodeSelection (halo painted).
 *          The announcer's signal is `ancestorChain.length > 0`, not
 *          `selectedBlockId === wrapperBridgeId`, so this leaves it
 *          untouched.
 *   NodeSelect → gear → drift → Esc reactivity end-to-end. NodeSelect Callout (halo on),
 *          gear-click (popover opens), drift selection into body (halo off),
 *          Esc (popover closes; the rAF setNodeSelection
 *          restore fires). Halo MUST re-paint. Catches the non-reactive hazard —
 *          reading `editor.state.selection` directly would be non-reactive
 *          (identity-preserving BlockSelection skips the re-render); routing
 *          through TipTap's `selected` NodeView prop propagates the change.
 *   Range that fully covers exactly one Callout: wrapper has
 *          `data-range-selected="true"` AND `data-selected` unset AND
 *          `::after` background channel paints (soft tone via
 *          `--selection-soft`), NOT border-color (full tone via `--ring`).
 *          Validates the soft halo paints on the inner wrapper without any
 *          competing full-halo rule biting on the same element.
 *
 * Real Chromium is required: `getComputedStyle(el, '::after')` does not
 * resolve `var(--selection-soft)` reliably under happy-dom / jsdom; Radix
 * popover lifecycles (rAF + onCloseAutoFocus) and the floating drag-handle
 * hover-then-click sequence don't replay deterministically off real browser.
 *
 * This file is NOT in the CI `test:e2e` file list
 * (`packages/app/package.json` dispatches a fixed subset for PR-tier runs);
 * generic `bunx playwright test` invocations run it for pre-push coverage.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

interface ApiSeed {
  seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void>;
}

async function setupDoc(page: Page, api: ApiSeed, markdown: string): Promise<string> {
  const docName = `halo-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return docName;
}

/** Programmatically NodeSelect the first jsxComponent matching componentName. */
async function nodeSelectFirstJsx(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    editor.chain().focus().setNodeSelection(pos).run();
  }, componentName);
}

/** Drift PM selection into the first matching jsxComponent's body — a
 *  TextSelection with $from inside the wrapper's content hole. */
async function driftSelectionIntoFirstJsxBody(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    editor
      .chain()
      .setTextSelection(pos + 2)
      .run();
  }, componentName);
}

async function selectionType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    return editor.state.selection.constructor.name;
  });
}

/** Double-rAF flush so rAF-scheduled `setNodeSelection` + TipTap's
 *  own rAF-debounced `handleSelectionUpdate` (which flips the `selected`
 *  NodeView prop via React `updateProps`) both complete before the test
 *  reads DOM. */
async function flushRaf(page: Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

// ── TextSelection-inside no longer paints the full halo ───────────

test('AC24: TextSelection inside a Callout body leaves data-selected unset and ::after opacity = 0', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  await driftSelectionIntoFirstJsxBody(page, 'Callout');
  expect(await selectionType(page)).toBe('TextSelection');

  expect(await callout.getAttribute('data-selected')).toBeNull();
  const opacityStr = await callout.evaluate((el) => window.getComputedStyle(el, '::after').opacity);
  expect(Number.parseFloat(opacityStr)).toBe(0);
});

// ── Grip-click on a Callout paints the halo ───────────────────────

test('AC25: grip-click on a Callout sets data-selected=true and the halo paints (opacity > 0)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });
  await callout.hover();

  const grip = page.locator('.ok-drag-grip').first();
  await expect(grip).toBeVisible({ timeout: 5_000 });
  await grip.click();

  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });
  expect(await selectionType(page)).toBe('NodeSelection');
  // Halo paint asserted as opacity > 0 rather than === 1 because the halo's
  // CSS transition (`globals.css` `.jsx-component-wrapper::after`) may still
  // be mid-flight when the test polls. The semantic invariant is "halo is
  // visible," not "transition complete."
  const opacityStr = await callout.evaluate((el) => window.getComputedStyle(el, '::after').opacity);
  expect(Number.parseFloat(opacityStr)).toBeGreaterThan(0);
});

// ── non-leaf ancestor still gets data-has-child-selected ──
//
// Mirrors the sibling test in selection-indicator.e2e.ts (which exercises the
// same invariant against the pre-refactor implementation) so the refactor of
// `hasChildSelected` from `!isInnermostSelected` to `!isInnermostInChain` is
// pinned against the nested-composite substrate. selection-indicator.e2e.ts
// also keeps passing — both files share the responsibility.

test('AC26 forward: nested Callout>Accordion, NodeSelect inner Accordion → outer Callout has data-has-child-selected and not data-selected', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n\n<Accordion title="Inner">\n\nbody\n\n</Accordion>\n\n</Callout>\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await nodeSelectFirstJsx(page, 'Accordion');
  const innerAccordion = page
    .locator('.jsx-component-wrapper[data-component-type="accordion"]')
    .first();
  const outerCallout = page
    .locator('.jsx-component-wrapper[data-component-type="callout"]')
    .first();

  await expect(innerAccordion).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(outerCallout).toHaveAttribute('data-has-child-selected', 'true');
  expect(await outerCallout.getAttribute('data-selected')).toBeNull();
  // The inner (chain leaf) never tags itself as its own ancestor.
  expect(await innerAccordion.getAttribute('data-has-child-selected')).toBeNull();
});

// ── chain-leaf wrapper under TextSelection-inside ─────────
//
// The new `isInnermostInChain` guard fires when the wrapper IS the chain
// leaf. Under TextSelection-inside-the-body, `isInnermostSelected` is now
// false on the Callout (no NodeSelection-on it), but the old guard
// `!isInnermostSelected` would have flipped TRUE and `.some()` would have
// promoted the Callout to "its own ancestor" (`data-has-child-selected=true`
// on the chain leaf). The new guard catches that.

test('AC26 inverse: TextSelection inside Callout body — chain-leaf Callout has no data-has-child-selected', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  await driftSelectionIntoFirstJsxBody(page, 'Callout');
  expect(await selectionType(page)).toBe('TextSelection');

  // halo off.
  expect(await callout.getAttribute('data-selected')).toBeNull();
  // isInnermostInChain fires — non-leaf guard short-circuits .some().
  expect(await callout.getAttribute('data-has-child-selected')).toBeNull();
});

// ── aria-live still updates for both halo and no-halo paths ───────

test('AC27: SelectionAnnouncer aria-live updates through TextSelection-inside → outside → NodeSelection-on transitions', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter paragraph\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });
  const liveRegion = page.locator('[role="status"][aria-live="polite"]');

  // Path A — TextSelection inside body. The halo does NOT paint,
  // but the announcer's input (ancestorChain.length > 0) is unchanged, so
  // the announcement still fires.
  await driftSelectionIntoFirstJsxBody(page, 'Callout');
  await expect(liveRegion).toContainText('Selected: Callout', { timeout: 2_000 });

  // Transit — move cursor to the "after" paragraph so the BlockSelection
  // identity genuinely changes (ancestorChain becomes empty). Without a
  // real identity change, useSyncExternalStore bails and the announcer's
  // useEffect doesn't re-fire — keeping Path A's textContent locked in
  // place. The transit announcement is "Outside any block" (the announcer's
  // explicit deselection cue per `SelectionAnnouncer.tsx`).
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().setTextSelection(editor.state.doc.content.size).run();
  });
  await expect(liveRegion).toContainText('Outside any block', { timeout: 2_000 });

  // Path B — grip-click NodeSelection on the Callout. BlockSelection
  // identity changes again (ancestorChain refills with the Callout entry).
  // Halo paints AND announcer re-announces.
  await callout.hover();
  const grip = page.locator('.ok-drag-grip').first();
  await expect(grip).toBeVisible({ timeout: 5_000 });
  await grip.click();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });
  await expect(liveRegion).toContainText('Selected: Callout', { timeout: 2_000 });
});

// ── popover round-trip re-paints the halo via reactive `selected` ────
//
// The reactivity hazard: reading `editor.state.selection` directly in render
// is non-reactive — `useBlockSelection` identity-preserves via
// `blockSelectionEqual`, so a TextSelection-inside-Callout →
// NodeSelection-on-Callout transition produced inside the popover-close
// `requestAnimationFrame` would not trigger a re-render and the halo would
// stay missing. Routing the gate through TipTap's `selected` NodeView
// prop instead flips via `updateProps` on every plugin-driven
// selection change. This test pins that end-to-end.

test('AC30: NodeSelect → gear → drift → Esc — halo re-paints after FR16 rAF restore', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  // Step 1 — grip-click NodeSelect (halo on).
  await callout.hover();
  const grip = page.locator('.ok-drag-grip').first();
  await expect(grip).toBeVisible({ timeout: 5_000 });
  await grip.click();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });

  // Step 2 — gear-click opens popover.
  const gear = callout.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  // Step 3 — drift PM selection into the body. Halo unpaints.
  await driftSelectionIntoFirstJsxBody(page, 'Callout');
  expect(await selectionType(page)).toBe('TextSelection');
  await expect.poll(() => callout.getAttribute('data-selected'), { timeout: 2_000 }).toBeNull();

  // Step 4 — Esc closes popover → `handleOpenChange(false)` schedules
  // `setNodeSelection(pos)` inside rAF. Halo MUST come back.
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });
  await flushRaf(page);

  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });
  // Halo re-paint asserted as opacity > 0 rather than === 1 — the halo's
  // CSS transition may still be mid-flight when the test polls. The
  // semantic invariant is "the halo came back," not "the transition
  // completed."
  const opacityStr = await callout.evaluate((el) => window.getComputedStyle(el, '::after').opacity);
  expect(Number.parseFloat(opacityStr)).toBeGreaterThan(0);
});

// ── range that fully covers single wrapper paints SOFT, not FULL ──
//
// TipTap's `selectNode()` fires `.ProseMirror-selectednode` on the outer
// React-renderer element for range-encompass-of-a-single-wrapper too, but
// no CSS rule keys off that class on the wrapper. The soft halo paints
// via `data-range-selected="true":not([data-selected="true"])` on the
// inner wrapper, and `data-selected` is unset because
// `isInnermostSelected = selected && !isRangeEncompassed` evaluates false
// when the wrapper is range-encompassed. Background channel paints soft;
// border-color stays transparent.

test('AC31: range covering exactly one Callout paints background (soft), not border-color (full)', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    'before paragraph\n\n<Callout type="note">\n\nbody\n\n</Callout>\n\nafter paragraph\n',
  );
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  // Build a TextSelection that fully covers exactly one Callout.
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    let size = 0;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === 'Callout') {
        pos = p;
        size = node.nodeSize;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error('Callout not found');
    const from = Math.max(0, pos - 1);
    const to = Math.min(editor.state.doc.content.size, pos + size + 1);
    editor.chain().focus().setTextSelection({ from, to }).run();
  });

  await expect(callout).toHaveAttribute('data-range-selected', 'true', { timeout: 2_000 });
  // data-selected MUST be unset on the range-encompassed wrapper.
  expect(await callout.getAttribute('data-selected')).toBeNull();

  const halo = await callout.evaluate((el) => {
    const cs = window.getComputedStyle(el, '::after');
    return {
      background: cs.background,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
    };
  });
  // Soft halo paints via background channel — colored, not transparent.
  expect(halo.backgroundColor).not.toMatch(/rgba?\(0,\s*0,\s*0,\s*0\)|^transparent\b/);
  // Border-color stays transparent — no full-halo rule paints on the
  // wrapper for range-encompass; only the soft background channel fills in.
  expect(halo.borderColor).toMatch(/rgba?\(0,\s*0,\s*0,\s*0\)|^transparent\b/);
});
