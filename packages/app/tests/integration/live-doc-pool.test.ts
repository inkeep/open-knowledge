import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  __liveDocPoolSize,
  type AcquireLiveDocResult,
  acquireLiveDocProvider,
  disposeLiveDocPool,
  type LiveDocPoolEntry,
  releaseLiveDocProvider,
} from '../../src/editor/components/live-doc-pool.ts';
import {
  createTestClient,
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  type TestServer,
} from './test-harness.ts';

let server: TestServer;
let collabUrl: string;

beforeAll(async () => {
  server = await createTestServer();
  collabUrl = `${server.wsUrl}/collab`;
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

afterEach(() => {
  disposeLiveDocPool();
});

function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function expectEntry(result: AcquireLiveDocResult): LiveDocPoolEntry {
  if (!result.ok) throw new Error(`acquire refused: ${result.reason}`);
  return result.entry;
}

describe('live-doc pool machinery', () => {
  test('two acquires on one key share a single entry; last release destroys it', async () => {
    const docName = `test-${crypto.randomUUID()}`;
    const first = expectEntry(acquireLiveDocProvider(collabUrl, docName));
    const second = expectEntry(acquireLiveDocProvider(collabUrl, docName));
    expect(second).toBe(first);
    expect(first.refcount).toBe(2);
    expect(__liveDocPoolSize()).toBe(1);

    releaseLiveDocProvider(collabUrl, docName);
    expect(__liveDocPoolSize()).toBe(1);
    expect(first.refcount).toBe(1);

    releaseLiveDocProvider(collabUrl, docName);
    expect(__liveDocPoolSize()).toBe(0);
    const third = expectEntry(acquireLiveDocProvider(collabUrl, docName));
    expect(third).not.toBe(first);
    releaseLiveDocProvider(collabUrl, docName);
  });

  test('syncs a real doc and fans live edits out to every subscriber', async () => {
    const client = await createTestClient(server.port);
    client.ytext.insert(0, 'first line');

    const entry = expectEntry(acquireLiveDocProvider(collabUrl, client.docName));

    let syncs = 0;
    let updates = 0;
    const unsubscribeA = entry.subscribe({ onSynced: () => syncs++, onUpdate: () => updates++ });
    let updatesB = 0;
    const unsubscribeB = entry.subscribe({ onSynced: () => {}, onUpdate: () => updatesB++ });

    await waitFor(() => entry.synced && entry.ySource.toString().includes('first line'));
    expect(syncs).toBeGreaterThanOrEqual(1);

    client.ytext.insert(client.ytext.length, '\nsecond line');
    await waitFor(() => entry.ySource.toString().includes('second line'));
    expect(updates).toBeGreaterThanOrEqual(1);
    expect(updatesB).toBeGreaterThanOrEqual(1);

    unsubscribeA();
    unsubscribeB();
    releaseLiveDocProvider(collabUrl, client.docName);
    await client.cleanup();
  });

  test('refuses system and config docNames before constructing any provider', () => {
    for (const name of [
      '__system__',
      '__config__/project',
      '__local__/project',
      '__user__/config.yml',
      '__config__/okignore',
    ]) {
      expect(acquireLiveDocProvider(collabUrl, name)).toEqual({
        ok: false,
        reason: 'inadmissible',
      });
    }
    expect(__liveDocPoolSize()).toBe(0);
  });
});
