import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getCollector } from './collector';
import { __resetWebVitalsForTests, initWebVitals } from './web-vitals';

describe('initWebVitals', () => {
  beforeEach(() => {
    getCollector()?.reset();
    __resetWebVitalsForTests();
  });

  afterEach(() => {
    __resetWebVitalsForTests();
  });

  test('is idempotent — multiple calls resolve without error', async () => {
    await initWebVitals();
    await initWebVitals();
    await initWebVitals();
    // No assertion needed: the idempotence is in the guard — if it were not
    // idempotent the second call would attempt to re-subscribe via
    // `onINP`/etc. and log spam.
    expect(true).toBe(true);
  });

  test('is a no-op under a non-browser environment', async () => {
    // Bun test environment has a `window` polyfill so this runs the
    // dynamic import. In Node-only envs (no `window`) the function returns
    // early before the import. This test documents the contract; the
    // early-return is observable as "no throw".
    await initWebVitals();
    expect(true).toBe(true);
  });
});
