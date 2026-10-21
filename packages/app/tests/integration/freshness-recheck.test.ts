import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getMetrics } from '../../../server/src/metrics';
import { createManualClock, type ManualClock } from '../../../server/src/watcher-clock.test-helper';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

const SEED = '# Doc\n\noriginal\n';

let server: TestServer | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.cleanup();
  await server?.cleanup();
  server = undefined;
});

interface Rig {
  server: TestServer;
  double: ReturnType<typeof createWatcherDouble>;
  clock: ManualClock;
  docName: string;
  file: string;
  client: TestClient;
}

async function openSeededDocument(options: {
  freshnessIntervalMs: number | null;
  debounce?: number;
  maxDebounce?: number;
}): Promise<Rig> {
  const double = createWatcherDouble();
  const clock = createManualClock(Date.now());
  server = await createTestServer({
    watcherBackend: double.backend,
    watcherClock: clock,
    freshnessIntervalMs: options.freshnessIntervalMs,
    debounce: options.debounce ?? 50,
    maxDebounce: options.maxDebounce ?? 200,
  });
  const docName = `freshness-${randomUUID()}`;
  const file = join(server.contentDir, `${docName}.md`);
  await agentWriteMd(server.port, SEED, { docName, position: 'replace' });
  await pollUntil(
    () => existsSync(file) && readFileSync(file, 'utf-8') === SEED,
    5_000,
    25,
    'the seed write to reach disk',
  );
  const client = await createTestClient(server.port, docName);
  clients.push(client);
  await pollUntil(() => client.ytext.toString() === SEED, 5_000, 25, 'the client to load the seed');
  return { server, double, clock, docName, file, client };
}

async function refresh(port: number, docNames: string[]): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/documents/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docNames }),
  });
}

describe('freshness through the server', () => {
  test('with native events silenced, the timed re-check applies an outside write to an open document byte for byte', async () => {
    const rig = await openSeededDocument({ freshnessIntervalMs: 5_000 });
    const outside = '# Doc\n\nchanged outside, never delivered\n';
    writeFileSync(rig.file, outside);
    const findsBefore = getMetrics().freshnessFinds;

    rig.clock.advance(5_000);
    await pollUntil(
      () => rig.client.ytext.toString() === outside,
      5_000,
      25,
      'the timed re-check to apply the outside bytes',
    );
    expect(readFileSync(rig.file, 'utf-8')).toBe(outside);
    expect(getMetrics().freshnessFinds - findsBefore).toBeGreaterThanOrEqual(1);
  });

  test('after a watcher error the server subscribes again, applies the write made in the gap, and takes later events', async () => {
    const rig = await openSeededDocument({ freshnessIntervalMs: null });
    const first = rig.double.subscriptionFor(rig.server.contentDir);
    first.fail(new Error('the native watcher died'));
    const gap = '# Doc\n\nwritten while the watcher was dead\n';
    writeFileSync(rig.file, gap);

    rig.clock.advance(0);
    await pollUntil(
      () => rig.client.ytext.toString() === gap,
      5_000,
      25,
      'the resubscribe re-check to apply the gap write',
    );
    expect(rig.double.subscriptionCount(rig.server.contentDir)).toBe(2);

    const later = '# Doc\n\ndelivered by the new subscription\n';
    writeFileSync(rig.file, later);
    rig.double.subscriptionFor(rig.server.contentDir).deliver([{ type: 'update', path: rig.file }]);
    await pollUntil(
      () => rig.client.ytext.toString() === later,
      5_000,
      25,
      'the new subscription to deliver the later write',
    );
  });

  test('a focus re-read merges an outside change made while the window was unfocused with unsaved typing', async () => {
    const rig = await openSeededDocument({
      freshnessIntervalMs: null,
      debounce: 60_000,
      maxDebounce: 120_000,
    });
    rig.client.ytext.insert(rig.client.ytext.length, '\nlive typing\n');
    await pollUntil(
      () =>
        rig.server.instance.hocuspocus.documents
          .get(rig.docName)
          ?.getText('source')
          .toString()
          .includes('live typing') ?? false,
      5_000,
      25,
      'the typing to reach the server',
    );
    writeFileSync(rig.file, '# Changed outside\n\noriginal\n');

    const response = await refresh(rig.server.port, [rig.docName]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checked: 1, found: 1 });
    await pollUntil(
      () => rig.client.ytext.toString().includes('# Changed outside'),
      5_000,
      25,
      'the focus re-read to merge the outside change',
    );
    expect(rig.client.ytext.toString()).toContain('live typing');
    expect(rig.client.ytext.toString()).not.toContain('<<<<<<<');
  });

  test('a client that reconnects to an open document gets the outside change made while it was away', async () => {
    const rig = await openSeededDocument({ freshnessIntervalMs: null });
    const away = await createTestClient(rig.server.port, rig.docName);
    clients.push(away);
    await pollUntil(() => away.ytext.toString() === SEED, 5_000, 25, 'the second client to load');

    let disconnected = false;
    away.provider.on('disconnect', () => {
      disconnected = true;
    });
    away.provider.disconnect();
    await pollUntil(() => disconnected, 5_000, 25, 'the second client to disconnect');

    const changed = '# Doc\n\nchanged while the client was away\n';
    writeFileSync(rig.file, changed);
    rig.clock.advance(1_000);
    let resynced = false;
    away.provider.on('synced', () => {
      resynced = true;
    });
    await away.provider.connect();
    await pollUntil(() => resynced, 10_000, 25, 'the second client to sync again');

    await pollUntil(
      () => away.ytext.toString() === changed,
      5_000,
      25,
      'the reconnect re-read to apply the outside change',
    );
    expect(rig.client.ytext.toString()).toBe(changed);
  });

  test('the refresh route skips the system document and names outside the content tree', async () => {
    const rig = await openSeededDocument({ freshnessIntervalMs: null });
    const response = await refresh(rig.server.port, ['__system__', '../outside', 'not-there']);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checked: 1, found: 0 });
  });

  test('the refresh route refuses an empty list', async () => {
    const rig = await openSeededDocument({ freshnessIntervalMs: null });
    const response = await refresh(rig.server.port, []);
    expect(response.status).toBe(400);
  });
});
