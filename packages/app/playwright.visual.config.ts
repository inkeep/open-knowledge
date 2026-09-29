import { availableParallelism } from 'node:os';
import { defineConfig } from '@playwright/test';
import { EXPECT_TIMEOUT_MS, resolveWorkerCount } from './playwright.config.ts';
import { SETUP_NON_RESULT_REPORTER } from './tests/stress/_helpers/setup-non-result-reporter.ts';

/**
 * Visual Playwright config — per-worker fixture isolation (same shape as
 * `playwright.config.ts` + `playwright.a11y.config.ts`).
 *
 * Previously this config used a shared `webServer` + module-level
 * `mkdtempSync` — abandoned upstream for the reasons documented in
 * `playwright.a11y.config.ts` (cross-worker CPU contention + macOS
 * IPv6-first `fetch` AggregateError on shared Vite). Visual snapshot
 * tests are especially sensitive to cross-worker CRDT state bleed
 * because the pixel output encodes live editor state (selection,
 * presence cursors, caret) — a single worker poisoning the shared
 * `test-doc.md` during a `test:visual:update` run bakes the corrupted
 * state into the golden baseline.
 *
 * Tests consume `test` + `api` + `baseURL` from
 * `tests/stress/_helpers/fixtures.ts` — the same per-worker fixture the
 * main suite uses. No visual-specific fixture file needed; the shared
 * one exposes everything the visual harness requires (per-worker server
 * + API helpers + per-worker content dir).
 */

/**
 * Off-CI worker count is derived from the same per-worker density as the main
 * suite rather than left to Playwright's default, because this config consumes
 * the identical per-worker fixture: each worker owns a full Vite + Hocuspocus +
 * Chromium stack, not just a browser. When an author invokes this suite on an
 * otherwise unloaded machine, the cap bounds local oversubscription.
 */

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/visual',
  globalSetup: './tests/stress/_helpers/i18n-catalog-freshness.ts',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  retries: 0,
  // Fail when baselines are missing rather than silently auto-blessing the
  // first run. Baseline updates require the explicit `test:visual:update`
  // script (which passes `--update-snapshots`) — same protocol as
  // `perf-baseline.json` updates. Prevents a regression authored in the same
  // changeset from becoming the golden.
  updateSnapshots: 'none',
  fullyParallel: true,
  workers: isCI ? 4 : resolveWorkerCount(availableParallelism()),
  reporter: [['list'], [SETUP_NON_RESULT_REPORTER]],
  use: {
    // `baseURL` is populated by the worker-scoped fixture in
    // `tests/stress/_helpers/fixtures.ts`. Leave unset so the fixture's
    // override takes effect per worker.
    headless: true,
  },
});
