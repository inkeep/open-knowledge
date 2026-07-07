/**
 * Graph-related Playwright helpers.
 *
 * Currently exposes the simulation-settled gate. Additional
 * graph-specific helpers (e.g. link-point / node-point waiters) can
 * migrate here as they hit the 2+ call-site extraction threshold.
 */

import type { Page } from '@playwright/test';

/**
 * Block until the force-layout simulation has reached its cooldown terminus
 * — `react-force-graph-2d`'s `onEngineStop` fires, latching
 * `simulationSettledRef` to `true` in `GraphView.tsx`. Before this point,
 * node positions drift under active physics; a canvas click computed from
 * a pre-settlement snapshot lands in the wrong place (beta drifts ~24px
 * in ~500ms vs a non-active 8px hit radius).
 *
 * Required before any `getGraphSurface(page).click({ position: ... })`
 * call whose position was captured via `getGraphNodeClickPoint` /
 * `getGraphLinkClickPoint`. Pure DOM-target clicks that don't depend on
 * simulation coordinates (`clickGraphDoc` / `clickGraphBackground` /
 * `clickGraphExternal` — all of which route through the harness) do NOT
 * need this gate.
 *
 * Consumes the DEV-gated `window.__graphHarness.isSimulationSettled()`
 * exposed from `GraphView.tsx` (tree-shaken from production bundles via
 * `import.meta.env.DEV`).
 */
export async function waitForGraphSimulationSettled(page: Page, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(() => window.__graphHarness?.isSimulationSettled() === true, null, {
    timeout: timeoutMs,
  });
}
