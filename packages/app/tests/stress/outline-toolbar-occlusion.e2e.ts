/**
 * Programmatic scroll into the editor must clear the absolute-positioned
 * `EditorToolbar` exclusion zone at the top of the scroll container.
 *
 * Bug shape: the editor toolbar (`EditorToolbar`, `absolute inset-x-0 top-0`)
 * overlays the top ~56 px of the scroll container (`ScrollPreservingContainer`
 * in `EditorActivityPool.tsx`). `pt-14` content padding protects the
 * initial-paint case but does NOT inset programmatic scroll alignment —
 * `scrollIntoView({block:'start'})` resolves to the scrollport top, which is
 * occluded by the toolbar. The four scroll-target call sites (outline-click
 * WYSIWYG / outline-click source-mode / wiki-link anchor / footnote
 * anchor click) all converge on this single missing invariant.
 *
 * The existing `outline-navigation.e2e.ts` assertion (`top < 250`) is too
 * permissive to detect the occlusion — a heading sitting AT scrollport-top
 * (y=0, behind a 56 px toolbar) satisfies `top < 250`. This file pins the
 * stricter invariant.
 *
 * Empirical setup notes:
 *   - Pre-render the full doc before clicking. ProseMirror lazy-renders
 *     content off-screen; smooth-scroll's destination is computed against the
 *     pre-scroll layout, so lazy renders during scroll throw the final
 *     target position into the wrong place AND can off-screen-overshoot in a
 *     way that masks the toolbar-occlusion bug. Scrolling to bottom then
 *     back to top forces the full layout.
 *   - Use enough content AFTER the target heading that `scrollIntoView`
 *     isn't clamped by `maxScrollTop`. A clamped scroll lands the heading
 *     below scrollport-top, which also masks the bug.
 *
 * Coverage:
 *   - WYSIWYG outline click — the outline `onNav` handler in TiptapEditor
 *     calling `target.scrollIntoView({block:'start'})` on the matched heading.
 *   - Wiki-link fragment URL navigation — TiptapEditor's anchor-scroll
 *     useEffect (the `tryScroll` closure). The test pins the shared
 *     `scroll-padding-top` CSS invariant by running a manual `scrollIntoView`
 *     after `primeFullLayout` resets the scrollport; it does NOT exercise
 *     the anchor-effect's resolution + retry logic (which a `primeFullLayout`
 *     between the `goto` and the manual scroll would have already reset).
 *   - Source-mode outline click (`applyOutlineNavigation` in `SourceEditor`).
 *     CodeMirror 6's `EditorView.scrollIntoView(pos,{y:'start'})` does NOT
 *     honour `scroll-padding-top` on any ancestor — CM6 walks the parent
 *     chain from `view.scrollDOM` and adjusts each scrollable ancestor's
 *     `scrollTop` directly, using its own `scrollMargins` facet for inset
 *     declarations. So the source-mode path needs a separate fix surface
 *     (`EditorView.scrollMargins.of(() => ({ top: 56 }))`), and this test
 *     pins it.
 *
 * Still skipped: footnote anchor click (`extensions/footnote-anchor-scroll.ts`)
 * — same invariant, same single-line CSS fix collapses it. Covered
 * transitively by the foundational contract.
 *
 * Note: a `data-testid="editor-toolbar"` was added to `EditorToolbar.tsx`'s
 * outer absolute-positioned div for stable selection. Tailwind utility
 * classes would identify the toolbar today, but coupling tests to className
 * strings is fragile under future style refactors.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test } from './_helpers';

const FILLER = 'Filler paragraph to force scrollable content. '.repeat(10);

// Section sizing: 10 filler paragraphs per section.
//
// Lower bound: the H2 target must sit far enough into the content that
// `scrollIntoView` is unclamped (target.contentY ≤ maxScrollTop). Smaller
// sections cause clamping that lands the heading below scrollport-top,
// masking the occlusion bug.
//
// Upper bound: ProseMirror lazy-renders content off-screen. Larger sections
// trigger render-during-scroll, which moves the target's content-Y mid-
// animation and overshoots the heading off-viewport — a different bug that
// also masks the occlusion.
const SECTION_FILLERS = 10;

const DOC = [
  '---',
  'title: Toolbar Occlusion Test',
  '---',
  '',
  '# First Heading',
  '',
  ...Array(SECTION_FILLERS).fill(FILLER),
  '',
  '## Target Heading',
  '',
  ...Array(SECTION_FILLERS).fill(FILLER),
  '',
  '### Last Heading',
  '',
  FILLER,
  FILLER,
].join('\n');

const TARGET_SLUG = 'target-heading';

/**
 * Seed a doc and wait for the editor + outline panel to be ready. Avoids the
 * `page-headings` API poll in `outline-navigation.e2e.ts`'s seed helper — its
 * `d.ok` check predates the current RFC 9457 success-envelope shape and now
 * reads `undefined`, so the poll spuriously returns 0. Waiting on the
 * rendered DOM avoids that brittleness — the DOM is the invariant the test
 * ultimately asserts on anyway.
 */
async function seedDoc(api: ApiHelpers, page: Page): Promise<string> {
  const docName = `occlusion-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

  await api.replaceDoc(docName, DOC);

  // Wait for the WYSIWYG DOM to render all three heading levels.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3').length === 3,
    null,
    { timeout: 15_000 },
  );

  return docName;
}

/**
 * Force-render the full doc, then reset scroll to the top. ProseMirror skips
 * layout work for off-screen content; without this prime step, the
 * smooth-scroll fired by the outline click computes its destination against
 * an incomplete layout, then content materializes mid-animation and the
 * target overshoots off-viewport. Scrolling to the end first materializes
 * every paragraph, after which the scroll math is stable.
 */
async function primeFullLayout(page: Page): Promise<void> {
  // Scroll to the bottom and poll until `scrollHeight` stops growing — each
  // ProseMirror lazy-render pass extends it, and two consecutive equal reads
  // (separated by the poll interval, i.e. ≥1 layout cycle) means the full doc
  // has materialized. Condition-based wait per the E2E STOP rule (no
  // `page.waitForTimeout`).
  let lastHeight = -1;
  await expect
    .poll(
      async () => {
        const h = await page.evaluate(() => {
          const s = document.querySelector('[data-testid="editor-scroll-container"]');
          if (!(s instanceof HTMLElement)) return -1;
          s.scrollTop = s.scrollHeight;
          return s.scrollHeight;
        });
        const stable = h > 0 && h === lastHeight;
        lastHeight = h;
        return stable;
      },
      { timeout: 6_000, intervals: [150, 250, 350] },
    )
    .toBe(true);

  // Reset to the top and poll until `scrollTop` is parked at 0 — scroll
  // anchoring can re-nudge it after the large content materialization above.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = document.querySelector('[data-testid="editor-scroll-container"]');
          if (!(s instanceof HTMLElement)) return -1;
          if (s.scrollTop !== 0) s.scrollTop = 0;
          return s.scrollTop;
        }),
      { timeout: 3_000, intervals: [100, 200] },
    )
    .toBe(0);
}

/**
 * Wait for the scroll container's `scrollTop` to stop moving for two
 * consecutive polls separated by ~150 ms. Smooth scrolling has end-state
 * jitter; asserting on intermediate positions yields flaky tests. Asserting
 * only when scroll has stabilized lets the test read the final geometry
 * once, deterministically.
 */
async function waitForScrollSettled(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const a = await page.evaluate(() => {
          const s = document.querySelector(
            '[data-testid="editor-scroll-container"]',
          ) as HTMLElement | null;
          return s?.scrollTop ?? 0;
        });
        await new Promise((r) => setTimeout(r, 150));
        const b = await page.evaluate(() => {
          const s = document.querySelector(
            '[data-testid="editor-scroll-container"]',
          ) as HTMLElement | null;
          return s?.scrollTop ?? 0;
        });
        return a === b && a > 50;
      },
      { timeout: 5_000, intervals: [200, 400] },
    )
    .toBe(true);
}

/**
 * Read `(target.top - toolbar.bottom)` in CSS pixels. Pre-fix this is
 * strongly negative (target lands at scrollport-top, fully behind the
 * 56 px toolbar); post-fix this is ≥ 0 (heading lands just below the
 * toolbar exclusion zone).
 */
async function targetTopMinusToolbarBottom(page: Page, targetSelector: string): Promise<number> {
  return page.evaluate((sel) => {
    const target = document.querySelector(sel);
    const toolbar = document.querySelector('[data-testid="editor-toolbar"]');
    if (!target || !toolbar) {
      throw new Error(`Missing element: target=${!!target}, toolbar=${!!toolbar}`);
    }
    return target.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
  }, targetSelector);
}

// Tolerance: allow up to 8 px of overlap to absorb the fade gradient + sub-
// pixel jitter. The bug under test produces ~-50 px delta (target sits at
// scrollport-top, ~50 px above toolbar.bottom), so an 8 px tolerance is two
// orders of magnitude smaller than the regression signal — a real occlusion
// can never satisfy it.
const TOOLBAR_OVERLAP_TOLERANCE_PX = 8;

test('WYSIWYG outline click lands the target heading below the editor toolbar', async ({
  page,
  api,
}) => {
  await seedDoc(api, page);
  await primeFullLayout(page);

  const outlinePanel = page.locator('#panel-outline');
  await expect(outlinePanel.getByRole('button', { name: 'Target Heading' })).toBeVisible();

  // Sanity: pre-click the scroll container is at top. The click must actually
  // move the viewport for the occlusion assertion to be meaningful.
  const scroller = page.locator('[data-testid="editor-scroll-container"]').first();
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeLessThan(50);

  await outlinePanel.getByRole('button', { name: 'Target Heading' }).click();

  // Wait for the smooth scroll to fully complete before measuring. `expect.poll`
  // on the delta directly would terminate on the FIRST satisfying sample,
  // which fires at t=0 (target initially well below the toolbar) and skips
  // the post-scroll terminal state entirely. Settling-first makes the
  // assertion deterministic.
  await waitForScrollSettled(page);

  // Sanity #1: the scroll genuinely moved (rules out the "no scroll fired,
  // heading happens to already satisfy the invariant" degenerate pass).
  const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollAfter).toBeGreaterThan(scrollBefore + 100);

  // Sanity #2: the heading actually landed inside the visible viewport
  // (rules out the "scroll overshot the heading off-screen below" failure
  // mode, which would also satisfy `top - toolbar.bottom >= 0` vacuously).
  // Viewport height is 720 (playwright.config.ts); the heading should sit
  // within the upper half of the visible scroll-container display area.
  const targetTopFinal = await page
    .locator('.ProseMirror h2')
    .first()
    .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(targetTopFinal).toBeLessThan(400);

  // Primary occlusion invariant. Pre-fix this is ~-56 (target sits at
  // scrollport-top, ~56 px above toolbar.bottom). Post-fix this should be
  // ≥ -8 (target at or just below toolbar.bottom; the small tolerance
  // absorbs the fade gradient and sub-pixel rounding).
  const delta = await targetTopMinusToolbarBottom(page, '.ProseMirror h2');
  expect(delta).toBeGreaterThanOrEqual(-TOOLBAR_OVERLAP_TOLERANCE_PX);
});

test('wiki-link anchor navigation lands the target heading below the editor toolbar', async ({
  page,
  api,
}) => {
  const docName = await seedDoc(api, page);
  await primeFullLayout(page);

  // `HeadingAnchors` slugifies via `toWikiLinkSlug` (lowercase, non-alnum→`-`,
  // trim edge `-`). "Target Heading" → "target-heading".
  await expect(page.locator(`#${TARGET_SLUG}`)).toBeVisible();

  const scroller = page.locator('[data-testid="editor-scroll-container"]').first();
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeLessThan(50);

  // Re-enter the same doc with a fragment anchor. TiptapEditor's
  // anchor-scroll useEffect (the `tryScroll` closure) reads
  // `window.location.hash`, parses the fragment, and calls
  // `scrollIntoView` on the matching element ID emitted by `HeadingAnchors`.
  // The effect is keyed by the provider, so it re-runs whenever the editor
  // mounts for a new doc — a `page.goto` is the user-realistic trigger.
  await page.goto(`/#/${docName}#${TARGET_SLUG}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector(`#${TARGET_SLUG}`);
  await primeFullLayout(page);
  // `primeFullLayout` resets the scroll to the top, so we re-trigger
  // `Element.scrollIntoView({block:'start'})` on the same target the
  // anchor-effect would resolve. This pins the shared `scroll-padding-top`
  // CSS invariant for the wiki-link target; the anchor-effect's resolution
  // and retry logic is exercised by the initial `page.goto` above but not
  // by this second invocation.
  await page.evaluate((slug) => {
    document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, TARGET_SLUG);

  await waitForScrollSettled(page);

  const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollAfter).toBeGreaterThan(scrollBefore + 100);

  const targetTopFinal = await page
    .locator(`#${TARGET_SLUG}`)
    .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(targetTopFinal).toBeLessThan(400);

  const delta = await targetTopMinusToolbarBottom(page, `#${TARGET_SLUG}`);
  expect(delta).toBeGreaterThanOrEqual(-TOOLBAR_OVERLAP_TOLERANCE_PX);
});

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

test('source-mode outline click lands the target heading line below the editor toolbar', async ({
  page,
  api,
}) => {
  await seedDoc(api, page);

  // Switch to Markdown source mode. The segmented toggle in `EditorToolbar`
  // renders as role="radio" with aria-label "Markdown source".
  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');

  await primeFullLayout(page);

  const outlinePanel = page.locator('#panel-outline');
  await expect(outlinePanel.getByRole('button', { name: 'Target Heading' })).toBeVisible();

  const scroller = page.locator('[data-testid="editor-scroll-container"]').first();
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeLessThan(50);

  // Outline click → `OUTLINE_NAV_EVENT` with `mode: 'source'` →
  // `applyOutlineNavigation` (in `SourceEditor`) →
  // `EditorView.scrollIntoView(line.from, {y:'start'})`. CM6 scrolls the
  // ScrollPreservingContainer ancestor (instant, not smooth) and — pre-fix —
  // ignores its `scroll-padding-top`, so the `## Target Heading` line lands
  // at scrollport-top, behind the 56 px toolbar overlay.
  await outlinePanel.getByRole('button', { name: 'Target Heading' }).click();

  await waitForScrollSettled(page);

  // Sanity #1: the scroll genuinely moved (rules out a no-op outline click
  // satisfying the invariant vacuously).
  const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollAfter).toBeGreaterThan(scrollBefore + 100);

  // The target is the `.cm-line` element holding the `## Target Heading` source
  // line. After the outline nav this is also `.cm-activeLine`, but matching on
  // text is robust to that detail; there is exactly one such line in the doc.
  const targetLine = page.locator('.cm-content .cm-line', { hasText: 'Target Heading' }).first();
  await expect(targetLine).toBeVisible();

  // Sanity #2: the line landed inside the visible viewport (rules out the
  // "scroll overshot the line off-screen below" failure mode, which would also
  // satisfy `top - toolbar.bottom >= 0` vacuously). Viewport height is 720.
  const lineTop = await targetLine.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(lineTop).toBeLessThan(400);

  // Primary occlusion invariant. Pre-fix this is ~-56 (line sits at
  // scrollport-top, ~56 px above toolbar.bottom). Post-fix (CM `scrollMargins`
  // top: 56) it should be ≥ -8.
  const delta = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-content .cm-line')].find((el) =>
      (el.textContent ?? '').includes('Target Heading'),
    );
    const toolbar = document.querySelector('[data-testid="editor-toolbar"]');
    if (!line || !toolbar) {
      throw new Error(`Missing element: line=${!!line}, toolbar=${!!toolbar}`);
    }
    return line.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
  });
  expect(delta).toBeGreaterThanOrEqual(-TOOLBAR_OVERLAP_TOLERANCE_PX);
});
