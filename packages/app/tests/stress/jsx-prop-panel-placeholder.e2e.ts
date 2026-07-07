/**
 * JSX prop-panel + placeholder UX.
 *
 * Pins the CSS `:has()` rule in `globals.css` that hides the slash-command
 * placeholder while a JSX prop panel is open. Three observable invariants:
 *
 *   P1. Placeholder paints by default on an empty paragraph in the editor.
 *   P2. Opening a JSX prop panel (gear → Radix popover) suppresses the
 *       placeholder via `content: none` on `p.is-empty::before`.
 *   P3. The hide is scoped to popover triggers inside `.jsx-component-chrome`.
 *       A Radix-shaped trigger sibling-to-but-outside the chrome (mimics
 *       wiki/internal-link panels routed through InteractionLayerStore, a
 *       distinct machinery from Radix-under-chrome) must NOT trigger the
 *       hide.
 *
 * Real Chromium is required: `:has()` and `getComputedStyle(el, '::before')`
 * resolution for stylesheet rules don't work reliably in happy-dom/jsdom.
 *
 * This file is NOT in the CI `test:e2e` file list (`packages/app/package.json`
 * dispatches a fixed subset for PR-tier runs); generic `bunx playwright test`
 * invocations run it for pre-push coverage.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

/** Read the computed `::before` content on the FIRST empty paragraph the
 *  Placeholder extension has tagged with `.is-empty`. Returns the empty
 *  string when no such paragraph exists. */
async function placeholderContent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const p = document.querySelector('.ProseMirror p.is-empty');
    if (!p) return '__no-empty-paragraph__';
    return window.getComputedStyle(p, '::before').content;
  });
}

async function setupDocWithTrailingEmptyParagraph(
  page: Page,
  api: { seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void> },
  componentMarkdown: string,
): Promise<string> {
  const docName = `placeholder-${randomUUID().slice(0, 8)}`;
  // The trailing blank line + paragraph guarantees an empty paragraph after
  // the JSX block. TipTap's Placeholder extension is configured with
  // `showOnlyCurrent: true` so the placeholder only paints when the cursor
  // lives on the empty paragraph — the test moves the cursor to doc end
  // below to put it there.
  await api.seedDocs([{ name: docName, markdown: `${componentMarkdown}\n\n` }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  // Programmatic focus + cursor-to-end. `.tiptap-editor` wrapper intercepts
  // pointer events on its gutters, and `setTextSelection` is more
  // deterministic than mapping coordinates to PM positions anyway.
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().setTextSelection(editor.state.doc.content.size).run();
  });
  return docName;
}

// ── P1+P2: placeholder hides when a Callout prop panel opens ─────────────

test('placeholder hides when Callout prop panel opens; restores on close', async ({
  page,
  api,
}) => {
  await setupDocWithTrailingEmptyParagraph(
    page,
    api,
    '<Callout type="note">\n\nbody\n\n</Callout>',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  // Baseline: placeholder paints. TipTap's Placeholder extension resolves the
  // `content: attr(data-placeholder)` rule against the configured string so
  // the computed value is the literal string in double quotes.
  const baseline = await placeholderContent(page);
  expect(baseline).toContain("Type '/' for commands");

  // Open the prop panel via the gear.
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  // Placeholder hidden — the `:has()` rule resolves `content: none`.
  await expect.poll(() => placeholderContent(page), { timeout: 2_000 }).toBe('none');

  // Close popover via Esc; the rule no longer matches so the placeholder
  // restores to its `attr(data-placeholder)` paint.
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });
  await expect
    .poll(() => placeholderContent(page), { timeout: 2_000 })
    .toContain("Type '/' for commands");
});

// ── P1+P2: same invariant on Accordion (composite type alt path) ─────────

test('placeholder hides when Accordion prop panel opens; restores on close', async ({
  page,
  api,
}) => {
  await setupDocWithTrailingEmptyParagraph(
    page,
    api,
    '<Accordion title="A">\n\nbody\n\n</Accordion>',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  const baseline = await placeholderContent(page);
  expect(baseline).toContain("Type '/' for commands");

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  await expect.poll(() => placeholderContent(page), { timeout: 2_000 }).toBe('none');

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });
  await expect
    .poll(() => placeholderContent(page), { timeout: 2_000 })
    .toContain("Type '/' for commands");
});

// ── P3: scope guard — popover-trigger outside .jsx-component-chrome ──────
//
// The wiki/internal-link prop panel (different machinery via
// InteractionLayerStore) opens a chip outside `.jsx-component-chrome`.
// Injecting a Radix-shaped trigger sibling-to-the-editor confirms the
// `:has(.jsx-component-chrome ...)` predicate is narrow: it must NOT
// match when the popover trigger is anywhere but inside the JSX chrome.

test('placeholder still paints when a Radix popover sibling to JSX chrome is open', async ({
  page,
  api,
}) => {
  await setupDocWithTrailingEmptyParagraph(
    page,
    api,
    '<Callout type="note">\n\nbody\n\n</Callout>',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  // Confirm baseline placeholder paints.
  const baseline = await placeholderContent(page);
  expect(baseline).toContain("Type '/' for commands");

  // Inject a Radix-shaped popover trigger INSIDE `.tiptap-editor` but
  // OUTSIDE every `.jsx-component-chrome`. The `:has()` selector must not
  // match this; the placeholder must keep painting.
  await page.evaluate(() => {
    const root = document.querySelector('.tiptap-editor');
    if (!root) throw new Error('.tiptap-editor not found');
    const btn = document.createElement('button');
    btn.setAttribute('data-slot', 'popover-trigger');
    btn.setAttribute('data-state', 'open');
    btn.textContent = 'fake-link-panel';
    root.appendChild(btn);
  });

  // The injected trigger now exists with `data-state="open"`. If the rule
  // were over-scoped (e.g., dropped the `.jsx-component-chrome` qualifier),
  // the placeholder would resolve `content: none`. The narrow rule must
  // keep the placeholder painting.
  await expect
    .poll(() => placeholderContent(page), { timeout: 2_000 })
    .toContain("Type '/' for commands");
});
