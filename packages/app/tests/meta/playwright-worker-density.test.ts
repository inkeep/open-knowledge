import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { LOGICAL_CPUS_PER_WORKER, resolveWorkerCount } from '../../playwright.config';

const CI_RUNNER_LOGICAL_CPUS = 16;

const SETUP_NON_RESULT_REPORTER_PATH = fileURLToPath(
  new URL('../stress/_helpers/setup-non-result-reporter.ts', import.meta.url),
);

const FIXTURE_SHARING_CONFIGS = {
  e2e: () => import('../../playwright.config'),
  a11y: () => import('../../playwright.a11y.config'),
  visual: () => import('../../playwright.visual.config'),
} as const;

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
    expect(config.workers).toBe(resolveWorkerCount(CI_RUNNER_LOGICAL_CPUS));
  });

  test.each(CONFIG_NAMES)(
    'off-CI the %s config derives workers from the density resolver',
    async (which) => {
      const config = await loadConfigWithCI(undefined, which);
      expect(config.workers).toBe(resolveWorkerCount(availableParallelism()));
    },
  );
});

describe('setup non-result rendering', () => {
  test.each(
    CONFIG_NAMES.flatMap((which) => [
      ['under CI', which, 'true'] as const,
      ['off-CI', which, undefined] as const,
    ]),
  )('%s the %s config registers the setup non-result reporter', async (_setting, which, ci) => {
    const { reporter } = await loadConfigWithCI(ci, which);
    expect(
      Array.isArray(reporter) ? reporter.map(([name]) => name) : [reporter],
      `the ${which} config runs specs on the shared stress fixture, which declares a worker-server setup non-result on the test that triggered it, but it does not register ${SETUP_NON_RESULT_REPORTER_PATH}, so that tier prints the non-result as an undifferentiated failure`,
    ).toContain(SETUP_NON_RESULT_REPORTER_PATH);
  });
});
