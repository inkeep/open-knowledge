/**
 * FR-7a: Source-mode toggle disabled when provider disconnected.
 *
 * Validates the required behavior:
 *   "UI in `packages/app/src/components/` (editor mode toggle component)
 *    disables the source-mode toggle when `provider.status !== 'connected'`.
 *    Tooltip: 'Source mode requires a live connection — your edits are
 *    saved and will appear when you reconnect.' Enabled again on
 *    provider reconnect."
 *
 * Why this test is browser-level: FR-7a is a UI-state behavior that
 * depends on React state propagating from HocuspocusProvider's status
 * subscription to the EditorHeader's disabled-prop branching. The
 * toggle's disabled state is not observable from unit tests without
 * rendering the component tree.
 *
 * Disconnect simulation uses Playwright's `page.routeWebSocket` (1.48+),
 * which can intercept NEW WebSocket connections and reject/close them.
 * The provider's reconnect logic triggers when the existing WS closes
 * (via ws.close() invocation), which cascades into the provider's
 * status → 'disconnected' → EditorHeader re-renders with disabled
 * source toggle.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const visualToggle = (page: Page) => page.getByRole('radio', { name: 'Visual editor' });

test.describe('FR-7a: source-mode toggle disabled during disconnect', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-fr7a-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  });

  test('connected state: source toggle is interactive', async ({ page }) => {
    // Sanity baseline — when provider is connected, both toggles are enabled.
    await expect(visualToggle(page)).toBeEnabled();
    await expect(sourceToggle(page)).toBeEnabled();
  });

  test('disconnected state: source toggle becomes disabled', async ({ page }) => {
    // `context.setOffline(true)` blocks NEW HTTP/WebSocket connections but
    // does NOT close existing WebSockets on Chromium — verified
    // empirically. HocuspocusProvider's status stays 'connected' in that
    // scenario.
    //
    // The reliable disconnect path is calling provider.disconnect() directly
    // via page.evaluate. The provider is exposed on window.__activeProvider
    // for testing. This matches what the UI would see from any real
    // disconnect cause (server restart, network failure that propagates to
    // the WS close event, user-initiated disconnect).
    await page.evaluate(() => {
      window.__activeProvider?.disconnect();
    });

    // Poll the DOM for the disabled state — the provider's status
    // change propagates through useSyncStatus to EditorHeader.
    await expect(sourceToggle(page)).toBeDisabled({ timeout: 15_000 });

    // Visual toggle remains enabled (only source is disabled during disconnect).
    await expect(visualToggle(page)).toBeEnabled();
  });

  test('reconnect re-enables source toggle without page reload', async ({ page }) => {
    // Start connected.
    await expect(sourceToggle(page)).toBeEnabled();

    // Disconnect.
    await page.evaluate(() => {
      window.__activeProvider?.disconnect();
    });
    await expect(sourceToggle(page)).toBeDisabled({ timeout: 15_000 });

    // Reconnect.
    await page.evaluate(() => {
      window.__activeProvider?.connect();
    });

    // Toggle re-enables (provider re-syncs, status returns to 'connected').
    await expect(sourceToggle(page)).toBeEnabled({ timeout: 30_000 });
  });

  test('disconnected state: tooltip text matches spec', async ({ page }) => {
    // The tooltip text is required to be: "Source mode requires a live
    // connection — your edits are saved and will appear when you reconnect."
    await page.evaluate(() => {
      window.__activeProvider?.disconnect();
    });
    await expect(sourceToggle(page)).toBeDisabled({ timeout: 15_000 });

    // Radix Tooltip — the disabled <button> doesn't receive hover events
    // reliably, so the implementation wraps it in a <span> which the
    // TooltipTrigger asChild pattern uses as the hover target. Hovering
    // the parent span fires the tooltip. Using .locator('..') walks up one
    // DOM level from the button to the wrapping span.
    const toggleWrapper = sourceToggle(page).locator('..');
    await toggleWrapper.hover();

    // Tooltip renders in a portal — look for the tooltip role containing
    // the spec-mandated substring. Allow a generous timeout for Radix's
    // delay-open behavior (default 700ms in @radix-ui/react-tooltip).
    const tooltipPattern = /Source mode requires a live connection/i;
    await expect(page.getByRole('tooltip').filter({ hasText: tooltipPattern })).toBeVisible({
      timeout: 5_000,
    });
  });
});
