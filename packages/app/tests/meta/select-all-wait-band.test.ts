import { describe, expect, test, vi } from 'vitest';

async function loadBand(ci: string | undefined) {
  vi.stubEnv('CI', ci);
  vi.resetModules();
  try {
    const config = (await import('../../playwright.config')).default;
    const helper = await import('../stress/_helpers/editor-state');
    return {
      configured: config.expect?.timeout,
      helper: helper.SELECT_ALL_SETTLE_TIMEOUT_MS,
    };
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

describe('select-all barrier wait band', () => {
  test('matches the configured expect budget on CI', async () => {
    const { configured, helper } = await loadBand('1');
    expect(helper).toBe(configured);
  });

  test('matches the configured expect budget locally', async () => {
    const { configured, helper } = await loadBand(undefined);
    expect(helper).toBe(configured);
  });
});
