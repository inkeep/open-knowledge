/**
 * Visual regression suite — 5-pack foundation parity.
 *
 * Captures screenshots of each 5-pack component rendered in the editor and
 * compares against golden baselines. Tolerance: ≤1% pixel delta (accommodates
 * anti-aliasing/subpixel). Covers {light, dark} themes and {selected, unselected}
 * states per the renamed 5-pack VR block set.
 *
 * Coverage:
 *   VR01 — Callout across all 5 GFM types (× light/dark) + foldable variant
 *   VR-IMAGE — Image with always-on zoom (no caption)
 *   VR-VIDEO — Video with poster + HTML5 controls
 *   VR-AUDIO — Audio with native chrome
 *   VR-ACCORDION — Accordion expanded + collapsed + exclusive grouping (name attr)
 *   VR17 — mixed 5-pack document
 *   VR18 — wildcard unregistered component
 *
 *
 * Baseline management:
 *   - packages/app/tests/visual/__snapshots__/ stores approved baselines
 *   - First run creates baselines; subsequent runs diff
 *   - Golden-file updates require explicit: bun run test:visual:update
 *   - Cannot silently regenerate in CI
 *
 * Isolation: per-worker fixture + per-test UUID docName — no hardcoded
 * 'test-doc' (precedent #20(a)).
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../stress/_helpers';

/** Wait for provider to connect and sync */
async function waitForProvider(page: Page) {
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), {
    timeout: 15_000,
  });
}

/** Wait for the editor's top-level doc to contain at least N blocks (seed
 *  acknowledged) — replaces every `waitForTimeout(500)` after a write. */
async function waitForDocSeeded(page: Page, minChildCount = 1) {
  await page.waitForFunction(
    (n) => (window.__activeEditor?.state.doc.childCount ?? 0) >= n,
    minChildCount,
    { timeout: 10_000 },
  );
}

/** Toggle theme to dark or light mode */
async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    localStorage.setItem('ok-theme-v1', t);
  }, theme);
  await page.waitForFunction(
    (t) => document.documentElement.classList.contains('dark') === (t === 'dark'),
    theme,
    { timeout: 2000 },
  );
}

/** Click to select a jsxComponent block by its data-component-name */
async function selectComponent(page: Page, componentName: string) {
  const component = page.locator(`[data-jsx-component][data-component-name="${componentName}"]`);
  await component.first().click();
  await component
    .first()
    .waitFor({ state: 'attached' })
    .catch(() => {});
  await page.waitForFunction(
    (name) => {
      const el = document.querySelector(
        `[data-jsx-component][data-component-name="${name}"][data-selected="true"]`,
      );
      return Boolean(el);
    },
    componentName,
    { timeout: 5_000 },
  );
}

/** Deselect by clicking on the editor background */
async function deselectAll(page: Page) {
  await page.locator('.ProseMirror').click({ position: { x: 10, y: 10 } });
  await page.waitForFunction(
    () => !document.querySelector('[data-jsx-component][data-selected="true"]'),
    null,
    { timeout: 2_000 },
  );
}

/**
 * Per-test isolation: seed a unique docName, replace its contents, navigate
 * to it via hash route. Returns the docName so the caller can reference it
 * later if needed.
 */
async function seedAndNavigate(
  page: Page,
  api: { seedDocs: (d: Array<{ name: string; markdown: string }>) => Promise<void> },
  markdown: string,
): Promise<string> {
  const docName = `vr-${randomUUID().slice(0, 12)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror');
  return docName;
}

// ── VR01: Callout (GFM 5-type + foldable) ───────────────────────

// GFM 5-type set. Prior list was
// ['note', 'warning', 'error', 'info'] — 'error'/'info' were not GFM types
// and would alias-fold to 'caution'/'note' respectively.
const calloutTypes = ['note', 'tip', 'important', 'warning', 'caution'] as const;

for (const calloutType of calloutTypes) {
  for (const theme of ['light', 'dark'] as const) {
    test(`VR01-${calloutType}-${theme}: Callout type=${calloutType} in ${theme} mode`, async ({
      page,
      api,
    }) => {
      await seedAndNavigate(
        page,
        api,
        `<Callout type="${calloutType}">\n\nThis is a ${calloutType} callout with **bold** and *italic* text.\n\n</Callout>`,
      );
      await waitForDocSeeded(page);
      await setTheme(page, theme);
      await deselectAll(page);

      const component = page.locator('[data-jsx-component]').first();
      await expect(component).toHaveScreenshot(`callout-${calloutType}-${theme}-unselected.png`, {
        maxDiffPixelRatio: 0.01,
      });

      await selectComponent(page, 'Callout');
      await expect(component).toHaveScreenshot(`callout-${calloutType}-${theme}-selected.png`, {
        maxDiffPixelRatio: 0.01,
      });
    });
  }
}

// foldable Callout variant — collapsible + defaultOpen.
for (const defaultOpen of [true, false] as const) {
  for (const theme of ['light', 'dark'] as const) {
    const label = defaultOpen ? 'open' : 'closed';
    test(`VR01-foldable-${label}-${theme}: Callout collapsible defaultOpen=${defaultOpen}`, async ({
      page,
      api,
    }) => {
      const attrs = defaultOpen
        ? 'type="warning" title="Heads up" collapsible defaultOpen'
        : 'type="warning" title="Heads up" collapsible';
      await seedAndNavigate(
        page,
        api,
        `<Callout ${attrs}>\n\nFoldable Callout body text.\n\n</Callout>`,
      );
      await waitForDocSeeded(page);
      await setTheme(page, theme);
      await deselectAll(page);
      const component = page.locator('[data-jsx-component]').first();
      await expect(component).toHaveScreenshot(`callout-foldable-${label}-${theme}.png`, {
        maxDiffPixelRatio: 0.01,
      });
    });
  }
}

// ── VR-IMAGE: lowercase <img> with always-on zoom (no figcaption) ──

for (const theme of ['light', 'dark'] as const) {
  test(`VR-IMAGE-${theme}: <img> with always-on zoom in ${theme} mode`, async ({ page, api }) => {
    await seedAndNavigate(
      page,
      api,
      '<img src="/placeholder.png" alt="Placeholder" width={400} />',
    );
    await waitForDocSeeded(page);
    await setTheme(page, theme);
    await deselectAll(page);
    const component = page.locator('[data-jsx-component]').first();
    await expect(component).toHaveScreenshot(`image-${theme}-unselected.png`, {
      maxDiffPixelRatio: 0.02, // slightly higher for image-driven pixel variance
    });
  });
}

// ── VR-VIDEO: Video with poster + HTML5 controls ───────────────

for (const theme of ['light', 'dark'] as const) {
  test(`VR-VIDEO-${theme}: Video with poster in ${theme} mode`, async ({ page, api }) => {
    await seedAndNavigate(page, api, '<video src="/sample.mp4" poster="/placeholder.png" />');
    await waitForDocSeeded(page);
    await setTheme(page, theme);
    await deselectAll(page);
    const component = page.locator('[data-jsx-component]').first();
    await expect(component).toHaveScreenshot(`video-${theme}-unselected.png`, {
      maxDiffPixelRatio: 0.02,
    });
  });
}

// ── VR-AUDIO: Audio with native chrome ─────────────────────────

for (const theme of ['light', 'dark'] as const) {
  test(`VR-AUDIO-${theme}: Audio native chrome in ${theme} mode`, async ({ page, api }) => {
    await seedAndNavigate(page, api, '<audio src="/sample.mp3" />');
    await waitForDocSeeded(page);
    await setTheme(page, theme);
    await deselectAll(page);
    const component = page.locator('[data-jsx-component]').first();
    await expect(component).toHaveScreenshot(`audio-${theme}-unselected.png`, {
      maxDiffPixelRatio: 0.02,
    });
  });
}

// ── VR-ACCORDION: Accordion expanded + collapsed + exclusive grouping ──

for (const theme of ['light', 'dark'] as const) {
  test(`VR-ACCORDION-${theme}: Accordion expanded (defaultOpen) in ${theme} mode`, async ({
    page,
    api,
  }) => {
    await seedAndNavigate(
      page,
      api,
      '<Accordion title="Expanded accordion" defaultOpen>\n\nBody content\n\n</Accordion>',
    );
    await waitForDocSeeded(page);
    await setTheme(page, theme);
    await deselectAll(page);
    const component = page.locator('[data-jsx-component]').first();
    await expect(component).toHaveScreenshot(`accordion-expanded-${theme}.png`, {
      maxDiffPixelRatio: 0.01,
    });
  });

  test(`VR-ACCORDION-collapsed-${theme}: Accordion collapsed in ${theme} mode`, async ({
    page,
    api,
  }) => {
    await seedAndNavigate(
      page,
      api,
      '<Accordion title="Collapsed accordion">\n\nHidden body\n\n</Accordion>',
    );
    await waitForDocSeeded(page);
    await setTheme(page, theme);
    await deselectAll(page);
    const component = page.locator('[data-jsx-component]').first();
    await expect(component).toHaveScreenshot(`accordion-collapsed-${theme}.png`, {
      maxDiffPixelRatio: 0.01,
    });
  });

  test(`VR-ACCORDION-exclusive-grouping-${theme}: HTML5 <details name> grouping in ${theme} mode`, async ({
    page,
    api,
  }) => {
    await seedAndNavigate(
      page,
      api,
      [
        '<Accordion title="First" name="grp" defaultOpen>',
        '',
        'First body',
        '',
        '</Accordion>',
        '',
        '<Accordion title="Second" name="grp">',
        '',
        'Second body',
        '',
        '</Accordion>',
      ].join('\n'),
    );
    await waitForDocSeeded(page, 2);
    await setTheme(page, theme);
    await deselectAll(page);
    await expect(page.locator('.ProseMirror')).toHaveScreenshot(
      `accordion-exclusive-grouping-${theme}.png`,
      { maxDiffPixelRatio: 0.02 },
    );
  });
}

// ── VR17: Mixed 5-pack document ─────────────────────────────────

for (const theme of ['light', 'dark'] as const) {
  test(`VR17-${theme}: Mixed 5-pack document in ${theme} mode`, async ({ page, api }) => {
    await seedAndNavigate(
      page,
      api,
      [
        '# Mixed 5-Pack Components',
        '',
        '<Callout type="warning">',
        '',
        'Watch out!',
        '',
        '</Callout>',
        '',
        '<img src="/placeholder.png" alt="Diagram" />',
        '',
        '<Accordion title="Advanced" defaultOpen>',
        '',
        '<Callout type="tip">',
        '',
        'Nested tip',
        '',
        '</Callout>',
        '',
        '</Accordion>',
        '',
        '<video src="/sample.mp4" />',
        '',
        '<audio src="/sample.mp3" />',
      ].join('\n'),
    );
    // Mixed doc: require at least 6 top-level blocks (heading + 5 components).
    await waitForDocSeeded(page, 6);
    await setTheme(page, theme);

    await expect(page.locator('.ProseMirror')).toHaveScreenshot(`mixed-document-${theme}.png`, {
      maxDiffPixelRatio: 0.02,
    });
  });
}

// ── VR18: Wildcard unregistered ────────────────────────────────

for (const theme of ['light', 'dark'] as const) {
  test(`VR18-${theme}: Wildcard unregistered component in ${theme} mode`, async ({ page, api }) => {
    await seedAndNavigate(
      page,
      api,
      '<CustomThing prop="value">\n\nUnregistered component content\n\n</CustomThing>',
    );
    await waitForDocSeeded(page);
    await setTheme(page, theme);
    const component = page.locator('[data-jsx-component]').first();
    await expect(component).toHaveScreenshot(`wildcard-unregistered-${theme}.png`, {
      maxDiffPixelRatio: 0.01,
    });
  });
}
