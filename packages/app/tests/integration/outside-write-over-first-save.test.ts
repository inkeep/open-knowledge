import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createManualClock } from '../../../server/src/watcher-clock.test-helper';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import { agentWriteMd, createTestClient, createTestServer, pollUntil } from './test-harness';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('an outside edit reported in one create with the first save of a new page reaches the open page', async () => {
  const double = createWatcherDouble();
  const server = await createTestServer({
    watcherBackend: double.backend,
    watcherClock: createManualClock(Date.now()),
    freshnessIntervalMs: 5_000,
  });
  cleanups.push(() => server.cleanup());
  const docName = `first-save-${randomUUID()}`;
  const file = join(server.contentDir, `${docName}.md`);
  const saved = '# New page\n\nFirst paragraph.\n';
  await agentWriteMd(server.port, saved, { docName, position: 'replace' });
  await pollUntil(
    () => existsSync(file) && readFileSync(file, 'utf-8') === saved,
    10_000,
    25,
    'the first save to reach disk',
  );
  const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
  cleanups.push(() => client.cleanup());
  await pollUntil(() => client.ytext.toString() === saved, 10_000, 25, 'the page to load');

  const outside = '# New page\n\nFirst paragraph, edited in another app.\n';
  writeFileSync(file, outside);
  double.subscriptionFor(server.contentDir).deliver([{ type: 'create', path: file }]);

  await pollUntil(
    () => client.ytext.toString().includes('edited in another app'),
    10_000,
    25,
    'the outside edit to reach the open page',
  );
  expect(readFileSync(file, 'utf-8')).toBe(outside);
}, 60_000);
