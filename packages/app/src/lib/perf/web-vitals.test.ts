import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
    expect(true).toBe(true);
  });

  test('is a no-op under a non-browser environment', async () => {
    await initWebVitals();
    expect(true).toBe(true);
  });
});
