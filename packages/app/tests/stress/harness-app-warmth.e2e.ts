/**
 * Worker-fixture app-warmth contract.
 *
 * The suite's retry design assumes retries run at >= first-attempt strength
 * ("retries absorb infra flake" — playwright.config.ts). Playwright boots a
 * fresh replacement worker per retry, so every retry's `goto` is that
 * worker's server's FIRST browser load. If the fixture's readiness guarantee
 * ends at the server (HTTP + /api/config + /collab) without covering the
 * app's first page load, that first load pays the full cold source-transform
 * graph — the warm-cache seed covers only Vite's dependency-optimizer cache —
 * and retries become structurally WEAKER than first attempts, inverting
 * retry-as-recovery: a test that flakes on attempt 1 under contention then
 * faces colder retries and hard-fails all attempts.
 *
 * Measurement shape (hardware-relative — absolute cold-load cost only
 * manifests on CI-class hardware): three fresh browser contexts against this
 * file's dedicated worker server. All pay a cold BROWSER cache, so the
 * first-vs-warm differential is dominated by server-side transform warmth;
 * common-mode runtime cost (CRDT /collab sync, tree render) inflates every
 * sample alike, and its per-sample VARIANCE is why the warm baseline is the
 * MIN of two samples (a single GC/scheduler spike in one warm sample must
 * not manufacture a false cliff). Two guards keep this from flaking:
 * - Absolute floor: a first load under 2.5s cannot blow any bounded
 *   first-interaction budget (>=10s in this suite) regardless of ratio, so
 *   sub-floor first loads pass outright — this deliberately ignores
 *   fast-hardware "cliffs" that are harmless in absolute terms.
 * - Generous ratio: a genuinely cold first load measures >=10x a warm one
 *   (14.8x on idle 18-core hardware); 4x still catches it with wide margin
 *   while tolerating tail noise between warm samples.
 */

import { expect, REQUIRED_FIXTURE_ENTRY_NAMES, test } from './_helpers';

// Dedicated worker for this file: option-value grouping gives it a private,
// freshly-booted server whose only prior browser load is the fixture's own
// warmup phase — no sibling test can add loads, so the measured first-vs-warm
// differential reflects exactly the state the fixture hands every test (and
// re-reddens if the warmup phase is removed: the first measure then becomes
// the server's genuinely-cold first browser load). The env value is a pure
// grouping token — nothing server-side reads it.
test.use({ workerServerEnv: { OK_TEST_WARMTH_CONTRACT: '1' } });

// Generous ceiling: the test MEASURES load time; it must not time out while
// measuring the cold case it exists to catch.
const APP_READY_TIMEOUT_MS = 90_000;
// Ratio denominators below this floor say more about scheduler jitter than
// server warmth; clamp so an anomalously fast warm load can't inflate the
// ratio.
const WARM_FLOOR_MS = 250;
// First loads faster than this cannot produce the failure class this test
// guards (bounded first-interaction budgets are >=10s suite-wide).
const COLD_FLOOR_MS = 2_500;
const MAX_COLD_TO_WARM_RATIO = 4;

test('fixture hands the FIRST browser load a warm app (retries must not be structurally weaker than first attempts)', async ({
  browser,
  workerServer,
}) => {
  async function measureAppReadyMs(): Promise<number> {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const start = Date.now();
      // Explicit goto ceiling matching the measurement budget: a regressed
      // cold load must surface through the ratio assertion's diagnostic
      // message, not a shorter default navigation timeout.
      await page.goto(`${workerServer.baseURL}/`, { timeout: APP_READY_TIMEOUT_MS });
      // App-interactive signal: the sidebar tree has rendered its
      // fixture-seeded row (same entry the fixture warmup gates on).
      await expect(
        page.getByRole('treeitem', { name: REQUIRED_FIXTURE_ENTRY_NAMES[0], exact: true }),
      ).toBeVisible({
        timeout: APP_READY_TIMEOUT_MS,
      });
      return Date.now() - start;
    } finally {
      await context.close();
    }
  }

  const firstLoadMs = await measureAppReadyMs();
  const warmSampleA = await measureAppReadyMs();
  const warmSampleB = await measureAppReadyMs();
  const warmBaselineMs = Math.max(Math.min(warmSampleA, warmSampleB), WARM_FLOOR_MS);

  const ratio = firstLoadMs / warmBaselineMs;
  expect(
    firstLoadMs < COLD_FLOOR_MS || ratio < MAX_COLD_TO_WARM_RATIO,
    `first browser load ${firstLoadMs}ms vs warm baseline ${warmBaselineMs}ms ` +
      `(min of ${warmSampleA}/${warmSampleB}ms; ratio ${ratio.toFixed(1)}x): the fixture ` +
      `handed the first load a structurally colder app than a warm one — every retry IS ` +
      `a first load on a fresh worker, so under CI contention this hard-fails all attempts`,
  ).toBe(true);
});
