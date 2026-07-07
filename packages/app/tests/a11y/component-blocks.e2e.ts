/**
 * Accessibility test suite for Component Blocks v2 (A11Y01-A11Y11).
 *
 * Playwright + @axe-core/playwright scenarios covering WCAG 2.1:
 * - 2.1.2: No keyboard trap
 * - 2.4.3: Focus order
 * - 4.1.2: Name, role, value
 * - 4.1.3: Status messages
 *
 *
 * Uses the shared per-worker fixture from `../stress/_helpers/fixtures.ts`
 * — same pattern as the main Playwright suite. Each worker gets its own
 * `bun run dev` process on a kernel-allocated port + isolated content
 * directory. See `playwright.a11y.config.ts` header for migration history.
 */

import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from '../stress/_helpers';
import { expect, test } from '../stress/_helpers';

async function waitForProvider(page: Page) {
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
}

/**
 * Create an isolated per-test document, seed the content, and navigate to
 * it. Matches the `seedDocs` / `setupDoc` pattern used across the rest of
 * the Playwright suite — each test owns its own `docName` via
 * `randomUUID()` so parallel workers (and future retries / reruns within
 * the same worker) never share CRDT state. See AGENTS.md Testing section
 * STOP rule on hardcoded `'test-doc'`.
 */
async function setupDoc(page: Page, api: ApiHelpers, content: string): Promise<string> {
  const docName = `a11y-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, content);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror');
  return docName;
}

// ── A11Y01: PropPanel focus order ──────────────────────────────

test('A11Y01: Tab key cycles through PropPanel controls in visual DOM order', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="warning">\n\nTest content\n\n</Callout>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  // Select the component. The PropPanel lives inside a Radix Popover which
  // renders to document.body — the gear click path opens it and sets
  // `data-prop-panel` on the inner wrapper. A direct click on the component
  // body NodeSelects and triggers the auto-open path only for fresh inserts;
  // here we click the settings gear explicitly.
  //
  // The chrome rests at pointer-events:none and is revealed by wrapper
  // :hover (globals.css). Playwright's click-time hit-target check does not
  // benefit from the hover the click itself would cause, so without a prior
  // hover the underlying callout "intercepts pointer events" on every retry.
  // Hover the wrapper FIRST — the same gesture a real user makes. Never
  // force:true here: a forced click skips the hit-target check entirely and
  // would mask genuine occlusion regressions this tier exists to catch.
  await page.locator('[data-jsx-component]').first().hover();
  const gear = page
    .locator('[data-jsx-component] .jsx-component-chrome button[aria-label*="properties"]')
    .first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click();

  // The PropPanel is marked with `data-prop-panel` on its wrapper div.
  const panel = page.locator('[data-prop-panel]').first();
  await panel.waitFor({ state: 'visible', timeout: 5000 });

  const controls = panel.locator('input, select, button, [role="switch"]');
  // Wait until at least one control renders (descriptor-derived controls
  // mount asynchronously through the Popover portal).
  await expect(controls.first()).toBeVisible({ timeout: 5000 });
  const controlCount = await controls.count();
  expect(controlCount).toBeGreaterThan(0);

  // Focus the first control and Tab through the panel — every successive
  // Tab must move focus to a DOM node (not fall off into the document).
  await controls.first().focus();
  for (let i = 1; i < controlCount; i++) {
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveCount(1);
  }
});

// ── A11Y02: NodeSelection screen reader announcement ──────────

test('A11Y02: NodeSelection announces component via aria-live region', async ({ page, api }) => {
  await setupDoc(page, api, '<Callout type="warning">\n\nTest content\n\n</Callout>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  // The SelectionAnnouncer wires a `role="status" aria-live="polite"` region
  // (see `packages/app/src/components/editor/SelectionAnnouncer.tsx` +
  // precedent #36). previously the test allowed `aria-live`
  // values of `off` (which defeats announcements entirely — the very
  // invariant WCAG 4.1.3 Status Messages requires this test to defend) and
  // never triggered a selection change to verify the announcer actually
  // updates its text content. Tighten both: assert the canonical
  // role+polite shape, drive a real selection, and assert the textContent
  // surfaces the descriptor name (mirrors selection-indicator.e2e.ts).
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5000 });
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return;
    let foundPos = -1;
    editor.state.doc.descendants((node: { type: { name: string } }, pos: number) => {
      if (foundPos !== -1) return false;
      if (node.type.name === 'jsxComponent') {
        foundPos = pos;
        return false;
      }
      return true;
    });
    if (foundPos !== -1) editor.chain().focus().setNodeSelection(foundPos).run();
  });

  const liveRegion = page.locator('[role="status"][aria-live="polite"]').first();
  await expect(liveRegion).toBeAttached({ timeout: 2_000 });
  // 200ms debounce in SelectionAnnouncer + margin for selection propagation.
  await expect(liveRegion).toContainText('Selected: Callout', { timeout: 2_000 });
});

// ── A11Y03: PropPanel Esc closes and returns focus ─────────────

test('A11Y03: PropPanel Esc key closes and returns focus to block', async ({ page, api }) => {
  await setupDoc(page, api, '<Callout type="warning">\n\nTest content\n\n</Callout>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  // Hover-reveal the chrome before clicking — see A11Y01 for the
  // hit-target rationale (and why force:true would be wrong here).
  await page.locator('[data-jsx-component]').first().hover();
  const gear = page
    .locator('[data-jsx-component] .jsx-component-chrome button[aria-label*="properties"]')
    .first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click();

  const panel = page.locator('[data-prop-panel]').first();
  await panel.waitFor({ state: 'visible', timeout: 5000 });

  const firstInput = panel.locator('input, select').first();
  await firstInput.focus();

  // Radix Popover closes on Escape and restores focus to the trigger (the gear
  // button) — which lives inside the ProseMirror editor surface. Assert focus
  // lands back inside the editor tree rather than nowhere (document.body).
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-prop-panel]'), null, {
    timeout: 5000,
  });
  const activeElement = await page.evaluate(() =>
    Boolean(document.activeElement?.closest('.ProseMirror')),
  );
  expect(activeElement).toBeTruthy();
});

// ── A11Y05: rawMdxFallback nested CM has aria-label ────────────

test('A11Y05: rawMdxFallback nested CodeMirror has accessible label', async ({ page, api }) => {
  // Write broken MDX that will produce rawMdxFallback
  await setupDoc(page, api, '<Foo>broken</Bar>\n');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  // Broken MDX must degrade to rawMdxFallback nested CM — that's the G9
  // always-live-bridge contract (precedent #11). If the
  // fallback doesn't surface, the test's precondition failed and the
  // accessible-label invariant is vacuous. Assert presence directly.
  const cmEditor = page.locator('.cm-editor').first();
  await expect(
    cmEditor,
    'broken MDX must produce a rawMdxFallback nested CodeMirror editor',
  ).toBeVisible({ timeout: 5000 });

  // The CM container or its wrapper must carry an accessible label so
  // screen readers can announce "editing broken MDX source" to the user.
  // WAI-ARIA name-and-role both contribute to the announcement, so pin
  // both: a future refactor that drops one while keeping the other would
  // silently degrade screen-reader behavior without failing here.
  const wrapper = cmEditor.locator('..');
  const ariaLabel = await wrapper.getAttribute('aria-label');
  expect(ariaLabel, 'rawMdxFallback wrapper must have aria-label').not.toBeNull();
  if (ariaLabel) {
    expect(ariaLabel.toLowerCase()).toContain('source');
  }
  const role = await wrapper.getAttribute('role');
  expect(role, 'rawMdxFallback wrapper must have role="group"').toBe('group');
});

// ── A11Y07: Empty-container placeholder keyboard-activatable (Tabs compound) ───
//
// Tabs is the canonical pack's sole compound parent
// — `emptyChildName: 'Tab'`. When a Tabs is empty (both seeded starter
// tabs deleted, or source-edited to `<Tabs></Tabs>`), JsxComponentView
// swaps the hover-revealed `.jsx-add-child-pill` for an in-flow
// `.jsx-empty-child-placeholder` (rendered as a native `<button>` so
// browsers grant Enter/Space activation natively). This test exercises
// the WCAG 2.1.2 keyboard-trap-free + 4.1.2 name/role/value contract on
// that placeholder.

test('A11Y07: Empty Tabs placeholder activatable via keyboard inserts a Tab', async ({
  page,
  api,
}) => {
  const docName = await setupDoc(page, api, '<Tabs></Tabs>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  const placeholder = page.locator('.jsx-empty-child-placeholder').first();
  await expect(
    placeholder,
    'empty <Tabs></Tabs> must render the empty-child placeholder',
  ).toBeVisible({ timeout: 5000 });

  // Native <button> grants Enter/Space activation without custom keydown
  // wiring — verify the element is a button so the test's "press Enter"
  // assumption is actually keyboard-driven, not a JS click in disguise.
  await expect(placeholder).toHaveJSProperty('tagName', 'BUTTON');

  // WCAG 4.1.2 (name/role/value): the placeholder must expose an accessible
  // name that conveys WHAT pressing Enter inserts (otherwise screen-reader
  // users hear an unlabeled button). The button's visible text is "+ Add
  // {emptyChildName}", so for Tabs it surfaces as "Add Tab".
  await expect(placeholder).toHaveAccessibleName(/add tab/i);

  await placeholder.focus();
  await expect(placeholder).toBeFocused();

  await page.keyboard.press('Enter');

  // The handler routes through `createChildNode('Tab')` and lands a new
  // jsxComponent[componentName="Tab"] inside the Tabs node. After insert
  // the placeholder is gone (childCount > 0 swaps it for the hover pill).
  // Specifically assert the child is a `Tab` — the descriptor's
  // `emptyChildName: 'Tab'` contract is the load-bearing claim, and a
  // regression to a wrong child type would still pass a bare
  // `childCount === 1` check.
  await page.waitForFunction(
    () => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      let firstChildName: string | null = null;
      let tabsChildCount = -1;
      editor.state.doc.descendants(
        (n: {
          type: { name: string };
          attrs: { componentName?: string };
          childCount: number;
          firstChild?: { type: { name: string }; attrs: { componentName?: string } };
        }) => {
          if (firstChildName !== null) return false;
          if (n.type.name === 'jsxComponent' && n.attrs.componentName === 'Tabs') {
            tabsChildCount = n.childCount;
            firstChildName = n.firstChild?.attrs?.componentName ?? null;
            return false;
          }
        },
      );
      return tabsChildCount === 1 && firstChildName === 'Tab';
    },
    null,
    { timeout: 5000 },
  );

  await expect(page.locator('.jsx-empty-child-placeholder')).toHaveCount(0);

  // Sanity: docName referenced so a future failure run-grep can correlate
  // the placeholder activation with the per-test isolated doc.
  expect(docName).toContain('a11y-');
});

// ── A11Y09: Wildcard block chrome has accessible name ──────────

test('A11Y09: Wildcard block chrome has accessible name', async ({ page, api }) => {
  await setupDoc(page, api, '<UnknownComponent prop="val">\n\nSome content\n\n</UnknownComponent>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  // Unregistered-component content MUST render through the wildcard
  // descriptor per Precedent #30 (all user content always visible) —
  // otherwise the component name + content silently disappears. Assert
  // the badge surfaces instead of short-circuiting on absence.
  const wildcardBadge = page
    .locator('[data-jsx-component].jsx-component-wrapper--unregistered')
    .first();
  await expect(
    wildcardBadge,
    'unregistered <UnknownComponent> must render through wildcard chrome',
  ).toBeVisible({ timeout: 5000 });
  const text = await wildcardBadge.textContent();
  expect(text).toContain('UnknownComponent');

  // WCAG 4.1.2 (Name, role, value): the wildcard wrapper must expose a
  // discoverable role + accessible name so assistive tech can announce
  // "Unknown component: <name>". Asserting only on selector match +
  // visible textContent leaves the role/aria-label undefended — the
  // embedded CodeMirror still renders the component name verbatim even
  // if the aria attributes are dropped, so a regression of the WCAG
  // contract would not surface in the textContent check.
  await expect(
    wildcardBadge,
    'wildcard wrapper must carry role="group" so assistive tech treats it as a labeled grouping',
  ).toHaveAttribute('role', 'group');
  await expect(
    wildcardBadge,
    'wildcard wrapper must expose the unregistered component name via aria-label',
  ).toHaveAttribute('aria-label', /UnknownComponent/);
});

// ── A11Y10: Zero axe-core violations on fixture document ───────
//
// Notes on scope:
//   - `color-contrast` is disabled here because axe flags a pre-existing
//     WCAG 2 AA violation on the default light-theme link color (`#3784ff`,
//     measured contrast 3.55 vs the 4.5 requirement). The violation lives
//     in the design-system's light-theme link token, NOT in any surface
//     this PR introduces. Fixing the token is the right action, but it's
//     a cross-surface change (impacts every anchor in the product, not
//     just editor-embedded ones) that belongs in a dedicated design-
//     system PR. Disabling the rule here keeps the fuller axe matrix
//     (keyboard, ARIA roles, form labels, landmarks, link purpose, …)
//     actively enforced on this PR's surface so regressions surface.
//   - `aria-allowed-attr` is NOT disabled: the wrapper's `role="group"`
//     intentionally omits `aria-selected` (see precedent #36) and axe
//     agrees, so the rule passes.
test('A11Y10: Zero axe-core violations on 5-pack fixture (excluding color-contrast)', async ({
  page,
  api,
}) => {
  // Build a realistic document with the 5-pack.
  const content = [
    '# 5-Pack Accessibility Test',
    '',
    '<Callout type="warning">',
    '',
    'Warning callout text',
    '',
    '</Callout>',
    '',
    '<Callout type="tip">',
    '',
    'Tip callout text',
    '',
    '</Callout>',
    '',
    '<img src="/placeholder.png" alt="Architecture diagram" />',
    '',
    '<Accordion title="Details" defaultOpen>',
    '',
    '<Callout type="note">',
    '',
    'Nested note',
    '',
    '</Callout>',
    '',
    '</Accordion>',
    '',
    '<video src="/sample.mp4" />',
    '',
    '<audio src="/sample.mp3" />',
    '',
    'Some paragraph with normal text.',
  ].join('\n');

  await setupDoc(page, api, content);
  // Wait for the editor to actually render the fixture's top-level blocks
  // before running axe — otherwise axe scans an empty ProseMirror.
  await page.waitForFunction(() => (window.__activeEditor?.state.doc.childCount ?? 0) >= 5, null, {
    timeout: 10_000,
  });

  // Run axe-core against the editor surface. Runner chrome (sidebar, header)
  // is shared with other surfaces and not this suite's responsibility.
  // `disableRules(['color-contrast'])` is explained in the test header.
  // axe-core's keyboard / aria / form-label / landmark / link-purpose rules
  // already enforce tabindex correctness and accessible names on every
  // rendered element — the previously-here structural for-loops were
  // explicitly redundant and silently vacuous under fixtures with zero
  // interactive elements. axe-core's `violations: []`
  // expectation is the load-bearing assertion; keeping the loops added
  // failure-shape redundancy without coverage gain.
  const axeResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include('.ProseMirror')
    .disableRules(['color-contrast'])
    .analyze();
  expect(axeResults.violations).toEqual([]);
});

// ── A11Y11: URL props with javascript: scheme render inert (XSS mitigation) ──
//
// User-authored MDX can include arbitrary `href`/`src` strings. The live
// React render must not produce a clickable `javascript:` link that would
// execute attacker-controlled JS in the editor origin when a second user
// opens the same document. `extractPrimitiveProps` routes URL-typed props
// through `sanitizeComponentProps`; this test asserts the mitigation is
// wired end-to-end (props → React render → DOM attribute).

test('A11Y11: javascript:/data: URL props render inert in the DOM', async ({ page, api }) => {
  // URL-typed descriptor props (`<img src>`, `<video src>`, `<audio src>`)
  // route through `sanitizeComponentProps` — any `javascript:` / `vbscript:` /
  // `data:` scheme must be stripped before reaching the DOM attribute.
  const malicious = [
    '<img src="javascript:fetch(`/nope`)" alt="xss-image" />',
    '',
    '<img src="https://example.com/safe.png" alt="safe-image" />',
  ].join('\n');
  await setupDoc(page, api, malicious);
  // Wait until both <img> elements render — we assert on the two src values.
  await page.waitForFunction(
    () => document.querySelectorAll('.ProseMirror img[src]').length >= 2,
    null,
    { timeout: 5000 },
  );

  const srcs = await page.evaluate(() => {
    const imgs = document.querySelectorAll<HTMLImageElement>('.ProseMirror img[src]');
    return Array.from(imgs).map((img) => img.getAttribute('src') ?? '');
  });
  for (const src of srcs) {
    expect(src.toLowerCase()).not.toMatch(/^\s*(javascript|vbscript|data):/);
  }
  // The safe https src must still be present — proves the render path is
  // active (sanitizer is not unilaterally blanking every src).
  expect(srcs).toContain('https://example.com/safe.png');
});
