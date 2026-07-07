import { defineConfig } from '@playwright/test';

/**
 * A11y Playwright config — per-worker fixture isolation (same shape as
 * `playwright.config.ts`).
 *
 * This config uses a per-worker fixture instead of a shared `webServer`
 * block + top-level `mkdtempSync`. The shared shape was abandoned in the
 * main Playwright config (see `playwright.config.ts` for the rationale:
 * cross-worker CPU contention + flake class on one shared Vite+Hocuspocus).
 *
 * The shared-webServer approach ALSO silently broke on macOS: Node's
 * global `fetch` inside the Playwright test worker tries IPv6 (`::1`)
 * before IPv4 on `localhost`, and Vite binds IPv4-only, producing
 * `TypeError: fetch failed / [cause]: AggregateError` on every
 * `test.beforeEach` call to `/api/test-reset`. Manual `curl` works; test-
 * worker `fetch` does not. The per-worker fixture pattern sidesteps this
 * because the fixture's own `fetch` polling happens outside the test
 * worker's Node-fetch context AND the tests consume the baseURL via a
 * fixture variable rather than a `process.env.VITE_PORT` lookup.
 *
 * Tests consume `test` + `api` + `baseURL` from
 * `tests/stress/_helpers/fixtures.ts` — same entry point as the main
 * Playwright suite. No a11y-specific fixture file; the shared one works
 * because it exposes what a11y needs (per-worker server + API helpers).
 */

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/a11y',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  retries: isCI ? 2 : 0,
  failOnFlakyTests: false,
  forbidOnly: isCI,
  fullyParallel: true,
  workers: isCI ? 4 : undefined,
  reporter: [['html', { open: 'never' }], ['list'], ...(isCI ? [['github'] as const] : [])],
  use: {
    // `baseURL` is populated by the worker-scoped fixture in
    // `tests/stress/_helpers/fixtures.ts`. Leave unset so the fixture's
    // override takes effect per worker.
    headless: true,
    video: { mode: 'retain-on-failure', size: { width: 1280, height: 720 } },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
