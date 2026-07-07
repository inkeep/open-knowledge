/**
 * JSX range-encompass soft halo — Playwright E2E.
 *
 * Pins the three observable behaviors that require a real browser:
 *
 *   - A TextSelection range from before a JSX wrapper to after it
 *     sets `data-range-selected="true"` on it AND the soft halo's
 *     ::after computed opacity is > 0.
 *   - Cmd+A (AllSelection) populates `data-range-selected="true"`
 *     on every JSX wrapper in the doc.
 *   - The soft tone (`background: var(--selection-soft)`) is
 *     visually distinguishable from the full ring halo
 *     (`border-color: var(--ring)`): captured `::after` styles
 *     differ between NodeSelected and range-encompassed states.
 *
 * Real Chromium is required: `getComputedStyle(el, '::after')` does not
 * resolve `var(--selection-soft)` reliably under happy-dom / jsdom.
 *
 * This file is NOT in the CI `test:e2e` file list
 * (`packages/app/package.json` dispatches a fixed subset for PR-tier
 * runs); generic `bunx playwright test` invocations run it for
 * pre-push coverage.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

interface ApiSeed {
  seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void>;
}

async function setupDoc(page: Page, api: ApiSeed, markdown: string): Promise<string> {
  const docName = `range-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return docName;
}

/** Dispatch a TextSelection from doc-start to doc-end. AllSelection-shaped
 *  selection produced by TipTap's `selectAll()` command — equivalent to
 *  the user pressing Cmd+A. Exercises the range-encompass derivation
 *  deterministically (avoids coordinate-based drag-select, which fights
 *  Playwright's actionability gates over the `contentEditable=false`
 *  wrapper chrome). */
async function selectAllText(page: Page) {
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().selectAll().run();
  });
}

/** Programmatically NodeSelect the first jsxComponent matching `componentName`.
 *  Used to drive "full halo" state without depending on hover-then-grip
 *  mouse coordination. */
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

/** Dispatch a TextSelection that fully covers the first jsxComponent matching
 *  `componentName`. Selection extends from just before the wrapper's open to
 *  just after its nodeSize — the minimum range that satisfies the
 *  `pos >= from && pos + nodeSize <= to` containment rule used by
 *  `deriveRangeEncompassedBlockIds`. Routed through TipTap's
 *  `setTextSelection` command rather than reaching into PM's `TextSelection`
 *  constructor — keeps the test free of cross-context imports. */
async function selectRangeOverFirstJsx(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    let size = 0;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        size = node.nodeSize;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    const from = Math.max(0, pos - 1);
    const to = Math.min(editor.state.doc.content.size, pos + size + 1);
    editor.chain().focus().setTextSelection({ from, to }).run();
  }, componentName);
}

// ── single-wrapper drag-select range marks data-range-selected ────

test('AC11: TextSelection range covering one Callout sets data-range-selected with opacity>0', async ({
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

  // Baseline: no wrapper carries range-selected before the range fires.
  expect(await callout.getAttribute('data-range-selected')).toBeNull();

  await selectRangeOverFirstJsx(page, 'Callout');

  // attribute pass-through.
  await expect(callout).toHaveAttribute('data-range-selected', 'true', { timeout: 2_000 });
  // Mutual exclusion: TextSelection-range does NOT NodeSelect the wrapper.
  expect(await callout.getAttribute('data-selected')).toBeNull();

  // soft halo paints — ::after opacity strictly > 0 (the CSS rule
  // resets the halo's --selection-halo-opacity to 1 via the explicit
  // `opacity: 1` declaration on the [data-range-selected] paint rule).
  // Polled rather than read once: globals.css `.jsx-component-wrapper::after`
  // has a 180ms opacity transition (`prefers-reduced-motion: no-preference`),
  // and Playwright can sample computed opacity at exactly t=0 of the
  // transition under parallel-worker CPU contention.
  await expect
    .poll(
      () =>
        callout.evaluate((el) => Number.parseFloat(window.getComputedStyle(el, '::after').opacity)),
      { timeout: 2_000 },
    )
    .toBeGreaterThan(0);
});

// ── Cmd+A paints soft halo on every JSX wrapper ───────────────────

test('AC12: Cmd+A populates data-range-selected on every JSX wrapper in the doc', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    'first\n\n<Callout type="note">\n\nbody\n\n</Callout>\n\nmiddle\n\n<Accordion title="A">\n\nbody\n\n</Accordion>\n\nlast\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  // Baseline: zero range-selected wrappers prior to selectAll.
  await expect(page.locator('.jsx-component-wrapper[data-range-selected="true"]')).toHaveCount(0);

  await selectAllText(page);

  // Every JSX wrapper in the doc carries data-range-selected. Total in this
  // fixture: Callout + Accordion = 2.
  await expect(page.locator('.jsx-component-wrapper[data-range-selected="true"]')).toHaveCount(2);
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  const accordion = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await expect(callout).toHaveAttribute('data-range-selected', 'true');
  await expect(accordion).toHaveAttribute('data-range-selected', 'true');
  // Mutual exclusion holds for both: AllSelection is not a NodeSelection.
  expect(await callout.getAttribute('data-selected')).toBeNull();
  expect(await accordion.getAttribute('data-selected')).toBeNull();
});

// ── soft halo tone is visually distinct from full halo ────────────

test('AC13: soft range halo paints a distinct background from the full ring halo', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.waitFor({ state: 'visible' });

  // State A: NodeSelect the Callout → full halo (border-color via --ring,
  // ::after background stays transparent / unset).
  await nodeSelectFirstJsx(page, 'Callout');
  await expect(callout).toHaveAttribute('data-selected', 'true');
  // The halo gate
  // routes through TipTap's `selected` NodeView prop, which flips via an
  // internal rAF (`ReactNodeViewRenderer.handleSelectionUpdate`). The 180ms
  // opacity transition (globals.css `.jsx-component-wrapper::after`) starts
  // on that rAF, so `data-selected="true"` can be observed in DOM exactly
  // when the transition is at t=0 (opacity computed value still 0). Poll
  // until the transition reads a non-zero opacity — the semantic invariant
  // is "halo paints," not "DOM attribute is set in the same frame."
  await expect
    .poll(
      () =>
        callout.evaluate((el) => Number.parseFloat(window.getComputedStyle(el, '::after').opacity)),
      { timeout: 2_000 },
    )
    .toBeGreaterThan(0);
  const fullHalo = await callout.evaluate((el) => {
    const cs = window.getComputedStyle(el, '::after');
    return {
      background: cs.background,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      opacity: cs.opacity,
    };
  });

  // State B: AllSelection → soft halo (background via --selection-soft,
  // border-color stays transparent / unset). NodeSelection is replaced
  // by AllSelection so `data-selected` clears before `data-range-selected`
  // takes over.
  await selectAllText(page);
  await expect(callout).toHaveAttribute('data-range-selected', 'true', { timeout: 2_000 });
  expect(await callout.getAttribute('data-selected')).toBeNull();
  const softHalo = await callout.evaluate((el) => {
    const cs = window.getComputedStyle(el, '::after');
    return {
      background: cs.background,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      opacity: cs.opacity,
    };
  });

  // The two paint channels differ. The full halo uses border-color (with
  // background staying transparent); the soft halo uses background (with
  // border-color staying transparent). Both yield opacity > 0 — the visual
  // distinction lives in which channel is painted.
  expect(softHalo.backgroundColor).not.toBe(fullHalo.backgroundColor);
  expect(softHalo.borderColor).not.toBe(fullHalo.borderColor);
  // The soft halo's resolved background must include a non-zero color.
  expect(softHalo.backgroundColor).not.toMatch(/rgba?\(0,\s*0,\s*0,\s*0\)|^transparent\b/);
  // Both states result in a visible halo (opacity > 0).
  expect(Number.parseFloat(fullHalo.opacity)).toBeGreaterThan(0);
  expect(Number.parseFloat(softHalo.opacity)).toBeGreaterThan(0);
});
