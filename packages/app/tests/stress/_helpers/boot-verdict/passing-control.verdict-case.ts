import { expect } from '@playwright/test';
import { recordBodyRan, bootedTest as test } from './verdict-fixture.ts';

test('a test whose worker server booted and whose body passes', async ({ workerServer }) => {
  recordBodyRan('passing-control', workerServer.baseURL);
  expect('required value').toBe('required value');
});
