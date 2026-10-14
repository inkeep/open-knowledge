import { describe, expect, test, vi } from 'vitest';

const ASSERTION_TIMEOUT_MS = 15_000;

const FIXTURE_SHARING_CONFIGS = {
  e2e: () => import('../../playwright.config'),
  a11y: () => import('../../playwright.a11y.config'),
} as const;

type ConfigName = keyof typeof FIXTURE_SHARING_CONFIGS;

async function loadConfig(which: ConfigName, ci: string | undefined) {
  vi.stubEnv('CI', ci);
  vi.resetModules();
  try {
    return (await FIXTURE_SHARING_CONFIGS[which]()).default;
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

const MODES = [
  { mode: 'locally', ci: undefined },
  { mode: 'under CI', ci: '1' },
] as const;

const CASES = (Object.keys(FIXTURE_SHARING_CONFIGS) as ConfigName[]).flatMap((which) =>
  MODES.map(({ mode, ci }) => ({ which, mode, ci })),
);

describe('playwright assertion timeout', () => {
  test.each(CASES)(
    '$mode the $which config gives web-first assertions a 15 s default',
    async ({ which, ci }) => {
      const config = await loadConfig(which, ci);
      expect(config.expect?.timeout).toBe(ASSERTION_TIMEOUT_MS);
    },
  );

  test.each(CASES)(
    '$mode the $which config keeps its per-test budget above the assertion default',
    async ({ which, ci }) => {
      const config = await loadConfig(which, ci);
      expect(config.timeout).toBeGreaterThan(ASSERTION_TIMEOUT_MS);
    },
  );
});
