import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { ProviderPool } from '@/editor/provider-pool';
import {
  driveHalfOpenForcedClose,
  makeTransportProof,
  socketStatus,
  waitForTransport,
} from '../half-open-forced-close.test-helper';
import { createTestServer, seedPoolServerInstanceId, type TestServer } from './test-harness';

const REAUTH_BREADCRUMB = 'ok-provider-server-driven-close-reauth';

const DECLINE_BREADCRUMB = 'ok-provider-half-open-forced-close';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  const run = cleanup;
  cleanup = null;
  await run?.();
  vi.restoreAllMocks();
});

test('the transport reset does not read as a server-driven doc close', async () => {
  const server: TestServer = await createTestServer();
  const pool = new ProviderPool(3, `${server.wsUrl}/collab`);
  const docName = `forced-close-reauth-${randomUUID()}`;

  cleanup = async () => {
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

  const infoSpy = vi.spyOn(console, 'info');
  const warnSpy = vi.spyOn(console, 'warn');

  driveHalfOpenForcedClose(provider);

  const attemptsAtClose = entry.serverDrivenCloseReauthAttempts;

  await waitForTransport('the socket to reconnect', () => socketStatus(provider) === 'connected');
  await proveTransportIsSyncing();

  const lines = [...infoSpy.mock.calls, ...warnSpy.mock.calls].map((args) =>
    args.map((arg) => String(arg)).join(' '),
  );

  expect(attemptsAtClose).toBe(0);
  expect(lines.filter((line) => line.includes(REAUTH_BREADCRUMB))).toEqual([]);
  expect(lines.filter((line) => line.includes(DECLINE_BREADCRUMB))).toHaveLength(1);
});
