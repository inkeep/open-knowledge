import { expect } from '@playwright/test';
import { recordBodyRan, bootedTest as test } from './verdict-fixture.ts';

test('a test whose worker server booted and whose body fails an assertion', async ({
  workerServer,
}) => {
  recordBodyRan('assertion-failure', workerServer.baseURL);
  expect('observed value').toBe('required value');
});
