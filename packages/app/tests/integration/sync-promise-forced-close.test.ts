import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { ProviderPool } from '@/editor/provider-pool';
import { invalidateSyncPromise, syncPromise, syncPromiseHasResolved } from '@/editor/sync-promise';
import {
  driveHalfOpenForcedClose,
  makeTransportProof,
  socketStatus,
  waitForTransport,
} from '../half-open-forced-close.test-helper';
import { createTestServer, seedPoolServerInstanceId, type TestServer } from './test-harness';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  const run = cleanup;
  cleanup = null;
  await run?.();
});

interface Arranged {
  provider: Parameters<typeof syncPromise>[1];
  docName: string;
  proveTransportIsSyncing: () => Promise<void>;
}

async function arrangeSyncedDoc(): Promise<Arranged> {
  const server: TestServer = await createTestServer();
  const pool = new ProviderPool(3, `${server.wsUrl}/collab`);
  const docName = `sync-gate-forced-close-${randomUUID()}`;

  cleanup = async () => {
    invalidateSyncPromise(docName);
    pool.dispose();
    await server.cleanup();
  };

  await seedPoolServerInstanceId(server, pool);
  const entry = pool.open(docName);
  if (entry === null || entry.kind !== 'active') throw new Error('expected an active pool entry');
  const provider = entry.provider;

  await waitForTransport('the first sync', () => entry.syncState === 'synced');

  const proveTransportIsSyncing = makeTransportProof(server, provider, docName);
  await proveTransportIsSyncing();

  return { provider, docName, proveTransportIsSyncing };
}

test('the mount gate reports synced only while the transport actually is', async () => {
  const { provider, docName, proveTransportIsSyncing } = await arrangeSyncedDoc();

  await syncPromise(docName, provider);
  expect(syncPromiseHasResolved(docName)).toBe(true);

  invalidateSyncPromise(docName);

  driveHalfOpenForcedClose(provider);

  const remountGate = syncPromise(docName, provider);
  expect(syncPromiseHasResolved(docName)).toBe(false);

  await waitForTransport('the socket to reconnect', () => socketStatus(provider) === 'connected');
  await proveTransportIsSyncing();

  await remountGate;
  expect(syncPromiseHasResolved(docName)).toBe(true);
});
