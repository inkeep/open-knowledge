import { expect } from '@playwright/test';
import { test } from '../fixtures.ts';

test('worker server owns its advertised endpoint', async ({ workerServer }) => {
  const response = await fetch(`${workerServer.baseURL}/api/config`);
  expect(response.ok).toBe(true);
  const config = (await response.json()) as { port: number };
  expect(config.port).toBe(workerServer.port);
});
