import { expect, REQUIRED_FIXTURE_ENTRY_NAMES, test } from './_helpers';

test.use({ workerServerEnv: { OK_TEST_WARMTH_CONTRACT: '1' } });

const APP_READY_TIMEOUT_MS = 90_000;
const WARM_FLOOR_MS = 250;
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
      await page.goto(`${workerServer.baseURL}/`, { timeout: APP_READY_TIMEOUT_MS });
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
