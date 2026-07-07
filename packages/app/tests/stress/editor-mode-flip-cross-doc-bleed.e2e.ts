/**
 * Bug-pin test for cross-doc DOM bleed via the source ↔ WYSIWYG mode-flip
 * flow.
 *
 * What the bug is. Open doc A (substantial content), navigate to doc B
 * (empty), toggle to Markdown source, toggle back to Visual editor. The
 * empty doc B's editor pane renders doc A's content above the empty
 * placeholder. Doc B's Y.Doc is empty both server- and client-side; the
 * issue is purely client-side DOM. The mechanism is the same as the
 * new-file-cross-doc-bleed surfaces: `@tiptap/react`'s
 * `PureEditorContent.componentDidMount`/`componentWillUnmount` move-all-
 * siblings primitive (`element.append(...editor.view.dom.parentNode.childNodes)`)
 * runs against a DOM parent that already contains BOTH editors'
 * `.tiptap.ProseMirror` divs as siblings.
 *
 * Empirically, the bleed is fully realized during the navigate step (Surface
 * 2 — `navigate-then-different-doc`). The mode-flip step is the user-
 * reported manifestation: after toggling away to source mode and back to
 * WYSIWYG, the bleed is still visible. The test exercises the full user
 * flow (navigate → toggle source → toggle visual) and asserts the
 * post-toggle DOM contract.
 *
 * Tier: Playwright e2e against the per-worker `bun run dev` fixture.
 *
 * STOP rules honored:
 *   - Unique docNames via randomUUID per test (CLAUDE.md: no hardcoded
 *     'test-doc' in Playwright tests; parallel workers corrupt CRDT state).
 *   - Assertions on user-visible DOM only (no editor.view.dom direct access,
 *     no React fiber probes). The contract a user observes is a DOM contract.
 */

import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

/**
 * Double-rAF yield inside the page context — a deterministic two-frame
 * settlement for "let React + TipTap finish their commit cycle" semantics
 * without coupling to internal globals. Matches the convention in
 * `_helpers/editor-state.ts` selectAllAndWaitForSelection. STOP-rule
 * compliant alternative to the banned wall-clock-wait pattern.
 */
async function yieldFramesInPage(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

const SEED_A_BODY = [
  '# Seed A (substantial content — mode-flip cross-doc bleed canary)',
  '',
  'This is the warm "long" doc; it stays in the Activity pool',
  'while Seed B (empty) is the active doc. If mode-flip causes any',
  'cross-Activity DOM transfer, Seed A content will leak into Seed B.',
  '',
  'CANARY_MODE_FLIP_BLEED_TOKEN_ABC_987654321FEDCBA',
  '',
  '## Section A',
  'Line 1 of section A. Line 2 of section A. Line 3 of section A.',
  '',
  '## Section B',
  'Line 1 of section B. Line 2 of section B.',
  '',
  '## Section C',
  'Line 1 of section C. Line 2 of section C. Line 3 of section C.',
].join('\n');

const CANARY = 'CANARY_MODE_FLIP_BLEED_TOKEN_ABC_987654321FEDCBA';

/**
 * Resolve the visible Activity's scroll container. The activity pool keeps
 * multiple Activities mounted (one per recent doc); hidden Activities carry
 * `display: none` via React 19's <Activity mode="hidden">. The `:visible`
 * Playwright pseudo-class targets only the active Activity's scroll
 * container, which is where the bleed manifests.
 */
function visibleScrollContainer(page: Page): Locator {
  return page.locator('[data-testid="editor-scroll-container"]:visible');
}

/**
 * The contract this test pins. After the navigate-then-mode-flip flow
 * completes and React + TipTap have settled, the visible Activity must
 * contain exactly one .tiptap.ProseMirror, and that PM's textContent must
 * be empty (the empty placeholder renders as `<p data-placeholder="..."><br/></p>`
 * with empty textContent).
 */
async function assertVisibleActivityHasOnlyEmptyEditor(page: Page): Promise<void> {
  const scroll = visibleScrollContainer(page);
  await expect(
    scroll,
    'exactly one editor scroll container should be visible after the mode-flip flow',
  ).toHaveCount(1);

  const pms = scroll.locator('.tiptap.ProseMirror:not(.composer-prosemirror)');
  await expect(
    pms,
    "empty-doc Activity must contain exactly one .tiptap.ProseMirror (cross-doc bleed signal: pmCount > 1 means another editor's view.dom has been vacuumed into this Activity's EditorContent ref div)",
  ).toHaveCount(1);

  await expect(
    pms.first(),
    "empty doc's editor must render empty placeholder content (cross-doc bleed signal: non-empty textContent means the orphaned PM is from a different doc)",
  ).toHaveText('');
}

test.describe('editor mode-flip cross-doc bleed', () => {
  test('open A, navigate to B (empty), source toggle, visual toggle: B Activity must contain exactly one empty editor', async ({
    page,
    api,
  }) => {
    test.setTimeout(60_000);

    const seedAName = `seed-a-${randomUUID()}`;
    const seedBName = `seed-b-${randomUUID()}`;
    // seedDocs handles the testReset + replace pipeline for non-empty
    // markdown; the agent-write-md endpoint returns 400 on empty bodies so
    // the empty B doc is created separately via createPage (which leaves
    // its Y.Doc empty by default — the exact scenario the mode-flip surface
    // requires).
    await api.seedDocs([{ name: seedAName, markdown: SEED_A_BODY }]);
    await api.createPage(`${seedBName}.md`);

    // Cold-open Seed A via hash navigation.
    await page.goto(`/#/${seedAName}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(CANARY)).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    // Sanity: exactly one visible PM with the canary text in seed A.
    await expect(
      visibleScrollContainer(page).locator('.tiptap.ProseMirror:not(.composer-prosemirror)'),
    ).toHaveCount(1);

    // Navigate to Seed B (empty). Both Activities are now mounted; B
    // becomes visible and A flips to <Activity mode="hidden">. The H6
    // vacuum can already realize the bleed during this step before any
    // mode-flip is triggered.
    await page.goto(`/#/${seedBName}`);
    await page.waitForFunction(
      (expected) => window.__providerPool?.getActiveDocName?.() === expected,
      seedBName,
      { timeout: 10_000 },
    );
    await waitForActiveProviderSynced(page);
    await yieldFramesInPage(page);
    await yieldFramesInPage(page);

    // Defocus before clicking the toggle — the toggle is a Radix radio
    // inside a ToggleGroup and should be reachable regardless of focus
    // state, but matching the mode-flip-driver pattern keeps the user-flow
    // model faithful.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.waitForFunction(
      () => document.activeElement === null || document.activeElement === document.body,
      null,
      { timeout: 1_000 },
    );

    // Toggle to Markdown source. CodeMirror mounts on the next animation
    // frame after the toggle; wait for `.cm-content` to settle.
    const sourceToggle = page.getByRole('radio', { name: 'Markdown source' });
    await sourceToggle.click();
    await expect(page.locator('.cm-editor').first()).toBeVisible({ timeout: 10_000 });
    await yieldFramesInPage(page);
    await yieldFramesInPage(page);

    // Toggle back to Visual editor.
    const visualToggle = page.getByRole('radio', { name: 'Visual editor' });
    await visualToggle.click();
    // Wait for ProseMirror to be visible (it was hidden via `content-visibility`
    // during source mode per the editor-mode-persistence pattern).
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 10_000,
    });
    await yieldFramesInPage(page);
    await yieldFramesInPage(page);

    // Bug assertion: exactly one empty PM in the visible Activity.
    await assertVisibleActivityHasOnlyEmptyEditor(page);
  });
});
