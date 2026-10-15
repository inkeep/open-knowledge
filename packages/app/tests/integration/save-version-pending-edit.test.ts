import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SaveVersionSuccessSchema } from '@inkeep/open-knowledge-core';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  awaitConvergedServerText,
  createTestClient,
  createTestServer,
  readTestDoc,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({
    debounce: 30_000,
    maxDebounce: 60_000,
    gitEnabled: true,
    commitDebounceMs: 30_000,
  });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

test('a version saved right after a client edit includes the edit', async () => {
  const docName = `pending-${crypto.randomUUID()}`;
  writeFileSync(join(server.contentDir, `${docName}.md`), '# Pending\n\nSaved line.\n', 'utf-8');
  const client = await createTestClient(server.port, docName);
  try {
    client.ytext.insert(client.ytext.length, '\nTyped just now.\n');
    await awaitConvergedServerText(server, client);
    expect(readTestDoc(server.contentDir, docName)).not.toContain('Typed just now.');

    const res = await fetch(`${server.baseUrl}/api/save-version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const { checkpointRef } = SaveVersionSuccessSchema.parse(await res.json());
    const version = checkpointRef.slice(checkpointRef.lastIndexOf('/') + 1);

    const git = (...args: string[]) =>
      execFileSync('git', [`--git-dir=${resolveShadowDir(server.contentDir)}`, ...args], {
        encoding: 'utf-8',
      });
    expect(git('show', `${version}:${docName}.md`)).toContain('Typed just now.');

    const parents = git('rev-list', '--parents', '-n', '1', version).trim().split(' ').slice(1);
    const parentsHoldingEdit = parents.filter((parent) =>
      git('ls-tree', '--name-only', parent).split('\n').includes(`${docName}.md`)
        ? git('show', `${parent}:${docName}.md`).includes('Typed just now.')
        : false,
    );
    expect(parentsHoldingEdit).toHaveLength(1);
  } finally {
    await client.cleanup();
  }
}, 60_000);
