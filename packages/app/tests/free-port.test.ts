import { describe, expect, test } from 'vitest';
import { getFreePort } from './free-port.test-helper.ts';

describe('getFreePort', () => {
  test('resolves a port in the valid range', async () => {
    const port = await getFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  test('resolves the requested loopback family without throwing', async () => {
    // Exercises the explicit-family binding path; 127.0.0.1 is always present
    // (::1 can be absent in IPv6-disabled CI, so it is not asserted here).
    const port = await getFreePort('127.0.0.1');
    expect(port).toBeGreaterThan(0);
  });
});
