import { afterEach, describe, expect, test, vi } from 'vitest';

async function loadE2eConfig(traceSnapshots: string | undefined) {
  vi.stubEnv('OK_E2E_TRACE_SNAPSHOTS', traceSnapshots);
  vi.resetModules();
  return (await import('../../playwright.config')).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('playwright trace snapshots', () => {
  test('the stability detector gate records traces without DOM snapshots', async () => {
    const config = await loadE2eConfig('off');
    expect(config.use?.trace).toEqual({ mode: 'on-first-retry', snapshots: false });
  });

  test('without the gate, first-retry traces keep their DOM snapshots', async () => {
    const config = await loadE2eConfig(undefined);
    expect(config.use?.trace).toBe('on-first-retry');
  });

  test.each(['', 'on', 'false'])(
    'a gate value other than off (%j) keeps DOM snapshots',
    async (value) => {
      const config = await loadE2eConfig(value);
      expect(config.use?.trace).toBe('on-first-retry');
    },
  );
});
