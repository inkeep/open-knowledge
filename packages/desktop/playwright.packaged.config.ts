import { defineConfig } from '@playwright/test';

/**
 * Packaged-app Playwright config — the release-gate tier.
 *
 * Runs a deliberately small subset of the SAME smoke files as
 * `playwright.config.ts`, but against a packaged `.app` bundle selected via
 * `OK_DESKTOP_PACKAGED_APP` (see `tests/smoke/_helpers/launch-desktop.ts`).
 * Two configs, one set of test files.
 *
 * Why a separate file rather than a `projects` array on the existing config:
 * introducing projects changes `testInfo.project.retries` resolution, which
 * `tests/smoke/_helpers/electron-stderr.ts` reads to decide whether to attach
 * main-process stderr. The required `desktop-smoke` check must keep behaving
 * exactly as it does today, so it keeps its own config untouched.
 *
 * No `globalSetup`: the unpackaged config's stale-build guard compares `src/`
 * against `out/`, neither of which describes a packaged bundle — running it
 * here would fail on a perfectly good DMG.
 */

/**
 * The FR5a subset: launch, project creation, and first-launch MCP wiring. This
 * is the smallest set that proves a DMG boots, reaches the renderer, and can
 * complete the first-run flow. Widening or narrowing it is a deliberate act —
 * `tests/unit/playwright-packaged-config.test.ts` pins the list.
 *
 * `cold-single-file-launch.e2e.ts` is here because it is packaged-ONLY in a
 * stronger sense than the rest: it starts the app through Launch Services
 * rather than launching Electron itself, so there is no unpackaged shape of it
 * to run. It is the only tier that observes the cold Apple-Event boot path.
 */
export const PACKAGED_SMOKE_SUBSET = [
  'cold-single-file-launch.e2e.ts',
  'consent-dialog.e2e.ts',
  'create-new-project.e2e.ts',
  'mcp-wiring.e2e.ts',
] as const;

/** Distinct from the unpackaged report so the two never overwrite each other. */
export const PACKAGED_JSON_REPORT_PATH = 'test-results/desktop-smoke-packaged-results.json';

export default defineConfig({
  testDir: './tests/smoke',
  testMatch: PACKAGED_SMOKE_SUBSET.map((file) => `**/${file}`),
  // Matches the unpackaged config's CI budget. A packaged launch is if anything
  // slower than `electron out/main/index.js` (Gatekeeper assessment, first-run
  // dyld cache warm-up), so a tighter budget would only add flake.
  timeout: process.env.CI ? 150_000 : 60_000,
  retries: process.env.CI ? 2 : 0,
  failOnFlakyTests: false,
  workers: 1,
  fullyParallel: false,
  // `json` is what the driver parses for its verdict; `list` keeps the CI log
  // readable. No `html` — nothing uploads a report for this tier.
  reporter: [['list'], ['json', { outputFile: PACKAGED_JSON_REPORT_PATH }]],
  use: {
    trace: 'retain-on-failure',
  },
});
