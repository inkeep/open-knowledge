import { defineConfig } from '@playwright/test';

/**
 * Per-worker server isolation: there is no `webServer` block — instead a
 * worker-scoped fixture at `tests/stress/_helpers/fixtures.ts`. Each
 * Playwright worker spawns its own `bun run dev` process on a
 * kernel-allocated port + unique tmpdir, eliminating the cross-worker CPU
 * contention that created a structural flake class under shared webServer.
 *
 * Per-test `baseURL` comes from the `baseURL` fixture in `fixtures.ts`, which
 * reads the worker's `workerServer.baseURL`. Consumers use
 * `test('...', async ({ page, api, baseURL }) => ...)` — no
 * `process.env.VITE_PORT` lookup required.
 */

/**
 * Single-browser (Chromium) — all E2E tests use programmatic clipboard
 * injection via `dispatchEvent(new ClipboardEvent(...))`, not real browser
 * clipboard APIs. Cross-browser clipboard differences (Safari user-activation
 * rules, Firefox async clipboard restrictions) are not exercised because the
 * tests bypass the native clipboard permission model entirely. Running 3×
 * browsers adds ~10 minutes of CI time with zero additional coverage.
 *
 * If future tests exercise REAL browser clipboard (e.g., `page.keyboard.press
 * ('Meta+V')` with system clipboard content), add per-file project scoping
 * for those tests only — not a global 3× multiplier.
 */
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/stress',
  testMatch: /.*\.e2e\.ts$/,
  // Build the per-run Vite optimizer seed cache once, before any worker
  // boots. Every fixture-spawned dev server copies it (see
  // tests/stress/_helpers/server-process.ts `VITE_E2E_SEED_DIR`) so no
  // server pays a cold dependency scan+optimize — the cold-optimizer
  // mid-test reload storms were the suite's dominant cross-cutting flake
  // class. Fail-open: a failed warm build logs and falls back to cold boots.
  globalSetup: './tests/stress/_helpers/global-warm-cache.ts',
  timeout: 120_000,
  // Web-first assertions poll until this budget, not Playwright's 5s default.
  // Under 4-worker CI load the suite's empirical convergence budget for
  // app-driven UI (CRDT round-trip + tree refresh + route update) is the
  // 10-15s band — which is why hundreds of call sites hand-bumped their
  // waits while any NEW bare assertion silently inherited the too-small 5s
  // default (a bare `toHaveURL` after folder-create lost exactly that race
  // and went PR-red). One config-level budget makes bare
  // assertions safe by default; the per-test `timeout: 120_000` still bounds
  // total damage. Keep inline `timeout:` overrides for genuinely exceptional
  // waits only (cold-start, provider sync) — not as the default idiom.
  expect: { timeout: isCI ? 15_000 : 5_000 },
  // failOnFlakyTests: false globally — retries absorb infra flake. Setting it
  // true (so retry-success still fails the PR) promoted infrastructure noise
  // (WebSocket EPIPE/ECONNRESET, transient CC1 broadcast jitter) to PR-red,
  // compounding the architectural CRDT fuzz/stress residual into an effective
  // ~22% PR-tier green rate on correct code. Persistent-flake detection runs
  // as ad-hoc CI-log audits rather than a nightly sweep.
  retries: isCI ? 2 : 0,
  failOnFlakyTests: false,
  forbidOnly: isCI,
  // workers=4 on `ubuntu-64gb` (16+ vCPU / 64 GB RAM shared runner). With
  // per-worker server fixtures, each worker spawns its own Vite+Hocuspocus
  // process + content directory, so worker count is bounded by runner CPU +
  // Vite cold-start budget rather than CRDT state contention. On a 2-vCPU
  // runner, workers=4 and workers=2 both oversubscribe and get cancelled at
  // the 15m timeout; only workers=1 (serial with retries, no CPU contention)
  // ran clean. ubuntu-64gb has headroom for 4 × (playwright worker + chromium
  // process + dev server) with retries=2. Per-test docName isolation +
  // per-worker server isolation together make fullyParallel fully safe.
  // If the CI runner tier changes back to 2 vCPU (e.g., ubuntu-64gb quota
  // exhausted), re-downgrade to workers=1.
  fullyParallel: true,
  workers: isCI ? 4 : undefined,
  reporter: [['html', { open: 'never' }], ['list'], ...(isCI ? [['github'] as const] : [])],
  use: {
    // `baseURL` is populated by the worker-scoped fixture in
    // `tests/stress/_helpers/fixtures.ts`. Leaving it unset here so the
    // fixture's override takes effect cleanly per worker.
    headless: true,
    // 1280×720 matches the most common default viewport; the default 800×450
    // crops the sidebar in narrow-viewport tests. Retained only on failure to
    // bound storage growth.
    video: { mode: 'retain-on-failure', size: { width: 1280, height: 720 } },
    // 'on-first-retry' captures trace on retry 1 only; subsequent retries skip
    // to stay under the CI runtime envelope.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
