import { availableParallelism } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import { LOGICAL_CPUS_PER_WORKER, resolveWorkerCount } from '../../playwright.config';

const CI_RUNNER_LOGICAL_CPUS = 16;

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

  test.each(
    CONFIG_NAMES,
  )('off-CI the %s config derives workers from the density resolver', async (which) => {
    const config = await loadConfigWithCI(undefined, which);
    expect(config.workers).toBe(resolveWorkerCount(availableParallelism()));
  });
});
