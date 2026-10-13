import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { OwnedServer } from '../../../stress/_helpers/reuse/server-supervisor.ts';

export async function runStandaloneLifetimeCase(
  server: OwnedServer,
  kind: 'exit' | 'peer',
): Promise<void> {
  const directory = process.env.OK_TEST_LIFETIME_DIR;
  if (directory === undefined) throw new Error('OK_TEST_LIFETIME_DIR is required');
  const response = await fetch(`${server.baseURL}/api/config`);
  expect(response.status).toBe(200);
  const identity = await fetch(`${server.baseURL}/__ok-test-server-identity`);
  expect(identity.status).toBe(200);
  writeFileSync(
    join(directory, `${kind}-ready.json`),
    JSON.stringify({
      pid: process.pid,
      server: {
        baseURL: server.baseURL,
        port: server.identity.port,
        contentDir: server.contentDir,
      },
      at: Date.now(),
      identity: await identity.json(),
      apiStatus: response.status,
    }),
  );
  const other = kind === 'exit' ? 'peer' : 'exit';
  await expect.poll(() => existsSync(join(directory, `${other}-ready.json`))).toBe(true);
  if (kind === 'exit') process.exit(83);
}
