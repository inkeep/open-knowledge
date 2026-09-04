import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

async function openFromSidebar(page: Page, filename: string) {
  const row = page.getByRole('treeitem', { name: filename, exact: true });
  await expect(row).toBeVisible();
  await row.click();
}

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

  const scroller = page
    .getByTestId('editor-scroll-container')
    .filter({ hasText: 'Doc A Bottom Marker' });
  await waitForStableScrollHeight(scroller);
  await scroller.evaluate((el) => el.scrollTo({ top: 1200, behavior: 'instant' }));
  const markerTopBefore = await bodyMarker(page).evaluate((el) => el.getBoundingClientRect().top);

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

  await expect
    .poll(() => visiblePanel(page).evaluate((el) => el.getBoundingClientRect().height))
    .toBeLessThan(panelOpenHeight - 100);

  await expect
    .poll(async () => {
      const top = await bodyMarker(page).evaluate((el) => el.getBoundingClientRect().top);
      return Math.abs(top - markerTopBefore);
    })
    .toBeLessThan(8);

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

  await expect
    .poll(() => visiblePanel(page).evaluate((el) => el.getBoundingClientRect().height))
    .toBeGreaterThan(panelOpenHeight - 20);

  await expect
    .poll(async () => {
      const top = await bodyMarker(page).evaluate((el) => el.getBoundingClientRect().top);
      return Math.abs(top - markerTopBefore);
    })
    .toBeLessThan(8);
});
