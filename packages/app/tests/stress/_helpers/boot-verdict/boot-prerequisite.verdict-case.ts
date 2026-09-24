import { recordBodyRan, bootFailureTest as test } from './verdict-fixture.ts';

test('a test whose worker server never finishes booting', async ({ workerServer }) => {
  recordBodyRan('boot-prerequisite', workerServer.baseURL);
});
