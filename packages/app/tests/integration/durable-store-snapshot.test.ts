import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { agentWriteMd, createTestServer, readTestDoc, type TestServer } from './test-harness';

let server: TestServer | undefined;
let contentDir: string | undefined;

afterEach(async () => {
  await server?.cleanup();
  server = undefined;
  if (contentDir) rmSync(contentDir, { recursive: true, force: true });
  contentDir = undefined;
});

test('HTTP save acknowledges a snapshot containing the new base and displaced version before restart', async () => {
  server = await createTestServer({ keepContentDir: true, debounce: 50, maxDebounce: 200 });
  contentDir = server.contentDir;
  const docName = 'durable-store';
  await agentWriteMd(server.port, 'original body\n', { docName, position: 'replace' });
  const original = readTestDoc(contentDir, docName);

  await agentWriteMd(server.port, 'acknowledged addition\n', { docName, position: 'append' });

  const acknowledged = readTestDoc(contentDir, docName);
  expect(acknowledged).toContain('acknowledged addition');
  expect(server.instance.durabilityState.getReconciledBase(docName)).toBe(acknowledged);
  expect(server.instance.durabilityState.isDisplacedVersion(docName, original)).toBe(true);
  const snapshot = readFileSync(
    join(server.instance.lockDir, 'stale-external-writes.json'),
    'utf8',
  );
  expect(snapshot).toContain('acknowledged addition');
  await server.cleanup();
  server = undefined;
  server = await createTestServer({ contentDir, keepContentDir: true });

  expect(server.instance.durabilityState.getReconciledBase(docName)).toBe(acknowledged);
  expect(server.instance.durabilityState.isDisplacedVersion(docName, original)).toBe(true);
  expect(readTestDoc(contentDir, docName)).toBe(acknowledged);
});
