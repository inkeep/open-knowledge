/**
 * The Properties collapse state is a LIVE, user-global preference shared across
 * all open documents (properties-collapsed-store). Toggling it on one doc
 * resizes the Properties section on every mounted doc — including hidden,
 * scrolled ones. Because that section sits ABOVE the document body, a naive raw
 * scrollTop restore would land a returning doc at the wrong place.
 *
 * ScrollPreservingContainer compensates by restoring a constant BODY offset
 * (relative to a body-top anchor) and recomputing it each poll frame, so the
 * panel settling to its post-toggle height after reveal doesn't shift the view.
 *
 * This pins the user-visible outcome: scroll A → toggle Properties on B → back
 * to A leaves the SAME body content at the SAME viewport position, while A's
 * panel does reflect the shared collapse (proving the state stayed live).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

async function openFromSidebar(page: Page, filename: string) {
  const row = page.getByRole('treeitem', { name: filename, exact: true });
  await expect(row).toBeVisible();
  await row.click();
}

/**
 * Wait until the scroller's content height stops changing (~300ms stable,
 * bounded at ~10s). The oracle snapshot below must be taken on SETTLED
 * content: while late paragraphs are still hydrating, content growth
 * triggers browser scroll-anchoring adjustments that legitimately shift
 * scrollTop (and fire scroll events the product records as the user's
 * position). A snapshot taken mid-hydration goes stale the moment such an
 * adjustment lands — the restore then faithfully preserves the ADJUSTED
 * position, and the assertion fails by exactly the adjustment delta.
 */
async function waitForStableScrollHeight(scroller: Locator) {
  const stabilized = await scroller.evaluate(async (el) => {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 200 && stable < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      if (el.scrollHeight === last) stable += 1;
      else {
        stable = 0;
        last = el.scrollHeight;
      }
    }
    return stable >= 6;
  });
  // Distinguish a timed-out stabilization from a genuine restore regression
  // in CI logs: a failure right after this warning means the snapshot below
  // may itself be unsettled (re-triage the hydration path, not the restore).
  if (!stabilized) {
    console.warn(
      '[props-toggle e2e] scrollHeight never stabilized within 10s; snapshot may be unsettled',
    );
  }
}

const FM = `---
type: daily-note
description: A description
title: Title
date: 2026-07-21
author: sarah
mood: ok
top3: []
gratitude: []
tags: [daily]
---
`;
const FILLER = 'Filler paragraph to force scrollable content. '.repeat(10);
const DOC_A = `${FM}# Doc A Heading\n\n${Array(30).fill(FILLER).join('\n\n')}\n\n## Doc A Bottom Marker\n\nEnd of doc A.`;
const DOC_B = `${FM}# Doc B Heading\n\nDoc B body paragraph.`;

const bodyMarker = (page: Page) =>
  page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Bottom Marker' });
const visiblePanel = (page: Page) => page.locator('[data-testid="property-panel"]:visible');

test('Properties toggle on another doc preserves scroll on return (shared + scroll-safe)', async ({
  page,
  api,
}) => {
  await api.seedDocs([
    { name: 'doc-a', markdown: DOC_A },
    { name: 'doc-b', markdown: DOC_B },
  ]);
  await page.goto('/');

  await openFromSidebar(page, 'doc-a.md');
  await waitForActiveProviderSynced(page);
  await expect(bodyMarker(page)).toBeVisible({ timeout: 30_000 });
  await expect(visiblePanel(page)).toBeVisible();
  const panelOpenHeight = await visiblePanel(page).evaluate(
    (el) => el.getBoundingClientRect().height,
  );

  // Scroll doc A into its body and record the body marker's viewport position
  // — on settled content only (see waitForStableScrollHeight).
  const scroller = page
    .getByTestId('editor-scroll-container')
    .filter({ hasText: 'Doc A Bottom Marker' });
  await waitForStableScrollHeight(scroller);
  await scroller.evaluate((el) => el.scrollTo({ top: 1200, behavior: 'instant' }));
  const markerTopBefore = await bodyMarker(page).evaluate((el) => el.getBoundingClientRect().top);

  // Nav to B, then collapse Properties there — the shared store collapses A too
  // while A is hidden.
  await openFromSidebar(page, 'doc-b.md');
  await waitForActiveProviderSynced(page);
  await expect(
    page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B Heading' }),
  ).toBeVisible({ timeout: 30_000 });
  await visiblePanel(page)
    .getByRole('button', { name: /properties/i })
    .click();

  // Back to A.
  await openFromSidebar(page, 'doc-a.md');
  await waitForActiveProviderSynced(page);
  await expect(bodyMarker(page)).toBeVisible({ timeout: 30_000 });

  // Shared state held: A's panel collapses to match the toggle. Poll rather than
  // a fixed wait — the collapse and the scroll-restore both settle over a few
  // frames after the doc is revealed.
  await expect
    .poll(() => visiblePanel(page).evaluate((el) => el.getBoundingClientRect().height))
    .toBeLessThan(panelOpenHeight - 100);

  // Scroll-safe: the same body content settles back to the same viewport
  // position (within a few px) despite the Properties height change.
  await expect
    .poll(async () => {
      const top = await bodyMarker(page).evaluate((el) => el.getBoundingClientRect().top);
      return Math.abs(top - markerTopBefore);
    })
    .toBeLessThan(8);

  // Expand direction (anchor moves DOWN, not up): re-open Properties on B, return
  // to A. A's panel grows while hidden; the restore must stay put through the
  // growth too — a sign error that only manifests on expand would surface here.
  await openFromSidebar(page, 'doc-b.md');
  await waitForActiveProviderSynced(page);
  await expect(
    page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B Heading' }),
  ).toBeVisible({ timeout: 30_000 });
  await visiblePanel(page)
    .getByRole('button', { name: /properties/i })
    .click();

  await openFromSidebar(page, 'doc-a.md');
  await waitForActiveProviderSynced(page);
  await expect(bodyMarker(page)).toBeVisible({ timeout: 30_000 });

  // Shared state held: A's panel is expanded again.
  await expect
    .poll(() => visiblePanel(page).evaluate((el) => el.getBoundingClientRect().height))
    .toBeGreaterThan(panelOpenHeight - 20);

  // Scroll-safe through the expand as well.
  await expect
    .poll(async () => {
      const top = await bodyMarker(page).evaluate((el) => el.getBoundingClientRect().top);
      return Math.abs(top - markerTopBefore);
    })
    .toBeLessThan(8);
});
