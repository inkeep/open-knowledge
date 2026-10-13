import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../../../stress/_helpers/fixtures.ts';

const directory = process.env.OK_TEST_LIFETIME_DIR;
if (directory === undefined) throw new Error('OK_TEST_LIFETIME_DIR is required');

test('lifetime subject: worker exits after both real servers are ready', async ({
  workerServer,
}) => {
  const response = await fetch(`${workerServer.baseURL}/api/config`);
  expect(response.status).toBe(200);
  const identity = await fetch(`${workerServer.baseURL}/__ok-test-server-identity`);
  expect(identity.status).toBe(200);
  writeFileSync(
    join(directory, 'exit-ready.json'),
    JSON.stringify({
      pid: process.pid,
      server: workerServer,
      at: Date.now(),
      identity: await identity.json(),
      apiStatus: response.status,
    }),
  );
  await expect.poll(() => existsSync(join(directory, 'peer-ready.json'))).toBe(true);
  process.exit(83);
});
