import { describe, expect, test } from 'vitest';
import { getFreePort } from './free-port.test-helper.ts';

describe('getFreePort', () => {
  test('resolves a port in the valid range', async () => {
    const port = await getFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  test('resolves the requested loopback family without throwing', async () => {
    const port = await getFreePort('127.0.0.1');
    expect(port).toBeGreaterThan(0);
  });
});
