import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getMetrics } from '../../../server/src/metrics';
import { createManualClock } from '../../../server/src/watcher-clock.test-helper';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness';

const SAVED = '# Doc\n\nShared paragraph.\n\nTail.\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface BatchEntry {
  status: string;
  docName: string;
  error?: { type?: string; detail?: string };
  outcome?: string;
  saved?: boolean;
  nextStep?: string;
}

function liveText(server: TestServer, docName: string): string {
  return server.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
}

async function seed(server: TestServer, docName: string): Promise<string> {
  const file = join(server.contentDir, `${docName}.md`);
  await agentWriteMd(server.port, SAVED, { docName, position: 'replace' });
  await pollUntil(
    () => existsSync(file) && readFileSync(file, 'utf-8') === SAVED,
    10_000,
    25,
    `${docName} on disk`,
  );
  return file;
}

describe('a batch agent write whose document closes while an earlier flush waits', () => {
  test('answers each document with its outcome instead of failing the whole batch', async () => {
    const double = createWatcherDouble();
    const server = await createTestServer({
      gitEnabled: true,
      commitDebounceMs: 50,
      watcherBackend: double.backend,
      watcherClock: createManualClock(Date.now()),
      freshnessIntervalMs: 5_000,
      debounce: 300_000,
      maxDebounce: 600_000,
    });
    cleanups.push(() => server.cleanup());
    const deliver = (events: Array<{ type: 'create' | 'delete'; path: string }>) =>
      double.subscriptionFor(server.contentDir).deliver(events);

    const waiting = `batch-waiting-${randomUUID()}`;
    const closing = `batch-closing-${randomUUID()}`;
    const waitingFile = await seed(server, waiting);
    const closingFile = await seed(server, closing);
    const client = await createTestClient(server.port, waiting, { skipInvariantWatcher: true });
    cleanups.push(() => client.cleanup());
    await pollUntil(() => client.ytext.toString() === SAVED, 10_000, 25, 'the client to load');

    const pendingBefore = getMetrics().vanishPending;
    const waitingMoved = join(server.contentDir, `${waiting}-moved.md`);
    renameSync(waitingFile, waitingMoved);
    deliver([{ type: 'delete', path: waitingFile }]);
    await pollUntil(
      () => getMetrics().vanishPending > pendingBefore,
      10_000,
      25,
      'the first document to be held',
    );

    const batch = fetch(`${server.baseUrl}/api/agent-write-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docs: [
          { docName: waiting, markdown: 'Batch line one.\n', position: 'append' },
          { docName: closing, markdown: 'Batch line two.\n', position: 'append' },
        ],
        agentId: 'batch-writer',
      }),
    });
    await pollUntil(
      () => liveText(server, closing).includes('Batch line two.'),
      10_000,
      25,
      'the batch to apply both entries',
    );

    const closingMoved = join(server.contentDir, `${closing}-moved.md`);
    renameSync(closingFile, closingMoved);
    deliver([
      { type: 'delete', path: closingFile },
      { type: 'create', path: closingMoved },
    ]);
    await pollUntil(
      () =>
        server.instance.hocuspocus.documents.get(closing)?.getMap('lifecycle').get('status') !==
        undefined,
      10_000,
      25,
      'the second document to follow its move',
    );
    deliver([{ type: 'create', path: waitingMoved }]);

    const response = await batch;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: BatchEntry[] };
    const [first, second] = body.results;
    expect(first?.error?.type).toBe('urn:ok:error:doc-moved');
    expect(second?.status).toBe('error');
    expect(second?.error?.type).toBe('urn:ok:error:doc-moved');
    for (const entry of [first, second]) {
      expect(entry).toMatchObject({
        outcome: 'projection-held',
        saved: false,
        nextStep: 're-read',
      });
    }
  }, 60_000);
});
