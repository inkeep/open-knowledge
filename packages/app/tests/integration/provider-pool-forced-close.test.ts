import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { ProviderPool } from '@/editor/provider-pool';
import {
  driveHalfOpenForcedClose,
  makeTransportProof,
  socketStatus,
  waitForTransport,
} from '../half-open-forced-close.test-helper';
import { createTestServer, seedPoolServerInstanceId, type TestServer } from './test-harness';

type ActiveEntry = Extract<NonNullable<ReturnType<ProviderPool['open']>>, { kind: 'active' }>;

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  const run = cleanup;
  cleanup = null;
  await run?.();
});

interface Arranged {
  entry: ActiveEntry;
  pool: ProviderPool;
  docName: string;
  proveTransportIsSyncing: () => Promise<void>;
}

async function arrangeForcedCloseAndReconnect(): Promise<Arranged> {
  const server: TestServer = await createTestServer();
  const pool = new ProviderPool(3, `${server.wsUrl}/collab`);
  const docName = `forced-close-${randomUUID()}`;

  cleanup = async () => {
    pool.dispose();
    await server.cleanup();
  };

  await seedPoolServerInstanceId(server, pool);
  const entry = pool.open(docName);
  if (entry === null || entry.kind !== 'active') throw new Error('expected an active pool entry');

  await waitForTransport('the first sync', () => entry.syncState === 'synced');

  const proveTransportIsSyncing = makeTransportProof(server, entry.provider, docName);
  await proveTransportIsSyncing();

  driveHalfOpenForcedClose(entry.provider);
  await waitForTransport(
    'the socket to reconnect',
    () => socketStatus(entry.provider) === 'connected',
  );
  await proveTransportIsSyncing();

  return { entry, pool, docName, proveTransportIsSyncing };
}

test('the entry reads synced again once the transport re-handshakes', async () => {
  const { entry } = await arrangeForcedCloseAndReconnect();

  expect(entry.syncState).toBe('synced');
});

test('a re-synced entry still flushes on the visibility resync', async () => {
  const { entry, pool, proveTransportIsSyncing } = await arrangeForcedCloseAndReconnect();
  const provider = entry.provider;

  await waitForTransport('the reconnected provider to settle', () => !provider.hasUnsyncedChanges);
  let flushed = false;
  const onUnsyncedChanges = () => {
    flushed = true;
  };
  provider.on('unsyncedChanges', onUnsyncedChanges);
  flushed = false;
  pool.resyncOnVisible();
  provider.off('unsyncedChanges', onUnsyncedChanges);

  expect(flushed).toBe(true);
  await proveTransportIsSyncing();
});

test('re-opening the doc keeps the provider that is still syncing', async () => {
  const { entry, pool, docName, proveTransportIsSyncing } = await arrangeForcedCloseAndReconnect();
  const provider = entry.provider;

  await waitForTransport('the reconnected provider to settle', () => !provider.hasUnsyncedChanges);
  const reopened = pool.open(docName);

  expect(reopened?.provider).toBe(provider);
  await proveTransportIsSyncing();
});
