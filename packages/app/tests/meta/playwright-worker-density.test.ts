/**
 * Playwright worker-density meta-guard.
 *
 * A worker in this suite is not a browser — it is a whole application stack:
 * a Vite dev server, a Hocuspocus CRDT server, a parse-worker pool, two
 * filesystem watchers, and a Chromium (see the worker-scoped fixture in
 * `tests/stress/_helpers/fixtures.ts`). Playwright's built-in default worker
 * count assumes its own stock topology, where workers own only a browser and
 * share one `webServer`, so leaving `workers` unset provisions roughly twice
 * the stacks a host can serve.
 *
 * Oversubscription does not fail any one test deterministically: it starves
 * whichever worker loses the scheduler lottery, so the suite loses a small,
 * arbitrary set of tests to timeouts on every run while the code under test is
 * correct. That is invisible to a per-test reviewer, which is why the density
 * is pinned here instead of trusted to the config's prose.
 *
 * The resolver is exercised against planted CPU counts — a guard that only
 * asserted the current host's value would go vacuously green on any machine
 * that happens to satisfy it. The config itself is exercised by re-importing
 * it with `process.env.CI` planted to each state, because it reads `CI` at
 * import time: an assertion on the ambient import sees only one arm. Under CI
 * `workers` is the runner-tier constant, so an off-CI regression back to
 * `undefined` (Playwright's shared-server default) would keep every
 * ambient-import assertion green in the one environment that gates merges.
 */

import { availableParallelism } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import { LOGICAL_CPUS_PER_WORKER, resolveWorkerCount } from '../../playwright.config';

/**
 * Every config whose tests consume the per-worker fixture in
 * `tests/stress/_helpers/fixtures.ts`. All three pay the same per-worker cost,
 * and `check:full:parallel` runs them concurrently at `--concurrency=100%`, so
 * the density contract has to hold across the set — bounding one tier while a
 * sibling keeps Playwright's default just relocates the oversubscription.
 *
 * Static importers rather than a computed specifier: the bundler has to see
 * each path literally to resolve it.
 */
/**
 * Logical CPUs on the CI runner tier the `workers: 4` literal was calibrated
 * against (`blacksmith-16vcpu-ubuntu-2404`, see the `workers` comment in
 * `playwright.config.ts`). Only used to prove the CI literal and the off-CI
 * resolver describe the same density.
 */
const CI_RUNNER_LOGICAL_CPUS = 16;

const FIXTURE_SHARING_CONFIGS = {
  e2e: () => import('../../playwright.config'),
  a11y: () => import('../../playwright.a11y.config'),
  visual: () => import('../../playwright.visual.config'),
} as const;

/**
 * Re-evaluate one config with `process.env.CI` planted to the given state and
 * return the resulting config object. The registry reset is what makes the
 * planted state observable — without it the module cache hands back the
 * ambient-environment evaluation.
 */
async function loadConfigWithCI(
  ci: string | undefined,
  which: keyof typeof FIXTURE_SHARING_CONFIGS = 'e2e',
) {
  const saved = process.env.CI;
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
  vi.resetModules();
  try {
    return (await FIXTURE_SHARING_CONFIGS[which]()).default;
  } finally {
    if (saved === undefined) delete process.env.CI;
    else process.env.CI = saved;
    vi.resetModules();
  }
}

const CONFIG_NAMES = Object.keys(
  FIXTURE_SHARING_CONFIGS,
) as (keyof typeof FIXTURE_SHARING_CONFIGS)[];

describe('playwright worker density', () => {
  test('one worker is budgeted a full application stack, not a bare browser', () => {
    // Pinned exactly: 4 is the ratio the CI calibration established (workers=4
    // on a 16+-vCPU runner), and every planted expectation below is derived
    // from it. A deliberate recalibration updates this and the table together.
    expect(LOGICAL_CPUS_PER_WORKER).toBe(4);
  });

  test.each([
    { logicalCpus: 0, expected: 1 },
    { logicalCpus: 1, expected: 1 },
    { logicalCpus: 2, expected: 1 },
    { logicalCpus: 3, expected: 1 },
    { logicalCpus: 4, expected: 1 },
    { logicalCpus: 7, expected: 1 },
    { logicalCpus: 8, expected: 2 },
    { logicalCpus: 16, expected: 4 },
    { logicalCpus: 18, expected: 4 },
    { logicalCpus: 64, expected: 16 },
  ])('$logicalCpus logical CPUs resolves to $expected worker(s)', ({ logicalCpus, expected }) => {
    expect(resolveWorkerCount(logicalCpus)).toBe(expected);
  });

  test('never exceeds the budgeted density on a host that can afford one worker', () => {
    for (let logicalCpus = LOGICAL_CPUS_PER_WORKER; logicalCpus <= 256; logicalCpus++) {
      expect(resolveWorkerCount(logicalCpus) * LOGICAL_CPUS_PER_WORKER).toBeLessThanOrEqual(
        logicalCpus,
      );
    }
  });

  test.each(CONFIG_NAMES)('under CI the %s config pins the runner-tier constant', async (which) => {
    const config = await loadConfigWithCI('true', which);
    expect(config.workers).toBe(4);
    // The CI count is a separate literal from the off-CI resolver, and the
    // whole justification for LOGICAL_CPUS_PER_WORKER is that off-CI runs at
    // the density CI was calibrated at. Assert that equivalence mechanically:
    // recalibrating the constant without revisiting the CI literal would
    // otherwise leave the two arms at different per-worker budgets, green.
    expect(config.workers).toBe(resolveWorkerCount(CI_RUNNER_LOGICAL_CPUS));
  });

  test.each(
    CONFIG_NAMES,
  )('off-CI the %s config derives workers from the density resolver', async (which) => {
    const config = await loadConfigWithCI(undefined, which);
    // `undefined` here is the regression: it hands the decision to Playwright's
    // shared-server default and reintroduces the oversubscription flake class.
    expect(config.workers).toBe(resolveWorkerCount(availableParallelism()));
  });
});
