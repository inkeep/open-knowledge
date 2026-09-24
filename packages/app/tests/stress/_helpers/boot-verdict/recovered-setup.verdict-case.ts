import { recordBodyRan, setupRecoveredOnRetryTest as test } from './verdict-fixture.ts';

test('a test whose setup completes only on its retry', async ({ workerServer }) => {
  recordBodyRan('recovered-setup', workerServer.baseURL);
});
