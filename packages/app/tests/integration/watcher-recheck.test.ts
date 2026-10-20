import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  getWatcherDecisionRingSnapshot,
  resetWatcherDecisionDiagnostics,
} from '../../../server/src/file-watcher';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer | undefined;
let client: TestClient | undefined;

afterEach(async () => {
  await client?.cleanup();
  client = undefined;
  await server?.cleanup();
  server = undefined;
});

describe('disk re-check through the server', () => {
  test('a write the watcher never delivered is found, applied to the live document and reported', async () => {
    const double = createWatcherDouble();
    server = await createTestServer({
      watcherBackend: double.backend,
      debounce: 50,
      maxDebounce: 200,
    });
    const docName = `recheck-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    await agentWriteMd(server.port, '# Doc\n\noriginal\n', { docName, position: 'replace' });
    await pollUntil(
      () => existsSync(file) && readFileSync(file, 'utf-8').includes('original'),
      5_000,
      25,
      'the agent write to reach disk',
    );
    client = await createTestClient(server.port, docName);
    await pollUntil(() => (client as TestClient).ytext.toString().includes('original'));

    writeFileSync(file, '# Doc\n\nchanged outside\n');
    const result = await server.instance.recheckDisk();
    expect(result.status).toBe('completed');
    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.dispatched).toBeGreaterThanOrEqual(1);

    await pollUntil(
      () => (client as TestClient).ytext.toString().includes('changed outside'),
      5_000,
      25,
      'the re-checked bytes to reach the live document',
    );

    const again = await server.instance.recheckDisk();
    expect(again).toEqual({ status: 'completed', candidates: 0, dispatched: 0 });
  });

  test('the injected backend delivers events the same way the native watcher does', async () => {
    const double = createWatcherDouble();
    server = await createTestServer({
      watcherBackend: double.backend,
      debounce: 50,
      maxDebounce: 200,
    });
    const docName = `delivered-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, '# Delivered\n\nfrom outside\n');
    resetWatcherDecisionDiagnostics();
    double.subscriptionFor(server.contentDir).deliver([{ type: 'create', path: file }]);
    await pollUntil(
      () =>
        getWatcherDecisionRingSnapshot().some(
          (record) =>
            record.decision === 'dispatched' &&
            record.kind === 'create' &&
            record.path.endsWith(`${docName}.md`),
        ),
      5_000,
      25,
      'the watcher to dispatch the delivered create',
    );
    client = await createTestClient(server.port, docName);
    await pollUntil(
      () => (client as TestClient).ytext.toString().includes('from outside'),
      5_000,
      25,
      'the delivered create to reach the live document',
    );
    expect(client.ytext.toString()).toContain('from outside');
    expect(double.subscriptionFor(server.contentDir).closed).toBe(false);
  });
});
