import { randomUUID } from 'node:crypto';
import { render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import WS from 'ws';

const DOM_WAIT = { timeout: 15_000, interval: 25 } as const;

interface ToastCall {
  kind: 'warning' | 'success';
  message: string;
  duration: number | undefined;
}

const toastLog: ToastCall[] = [];
const dismiss = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    warning: (message: unknown, options?: { duration?: number }) => {
      toastLog.push({ kind: 'warning', message: String(message), duration: options?.duration });
    },
    success: (message: unknown, options?: { duration?: number }) => {
      toastLog.push({ kind: 'success', message: String(message), duration: options?.duration });
    },
    dismiss: (...args: unknown[]) => dismiss(...args),
    error: () => {},
  },
}));
vi.mock('@/lib/relaunch-store', () => ({ useRelaunchInFlight: () => false }));

import { ProviderPool } from '@/editor/provider-pool';
import {
  driveHalfOpenForcedClose,
  makeTransportProof,
  socketStatus,
  waitForTransport,
} from '../../tests/half-open-forced-close.test-helper';
import {
  createTestServer,
  seedPoolServerInstanceId,
  type TestServer,
} from '../../tests/integration/test-harness';
import { useSyncStatus } from './use-sync-status';
import { useSyncToasts } from './use-sync-toasts';

beforeAll(() => {
  vi.stubGlobal('WebSocket', WS);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  const run = cleanup;
  cleanup = null;
  await run?.();
  toastLog.length = 0;
  dismiss.mockClear();
});

function SyncStatusProbe({
  provider,
  docName,
}: {
  provider: Parameters<typeof useSyncStatus>[0];
  docName: string;
}) {
  const status = useSyncStatus(provider);
  useSyncToasts(status, docName);
  return <output data-testid="sync-status">{status}</output>;
}

const shownStatus = () => screen.getByTestId('sync-status').textContent;

const standingToast = () => toastLog.at(-1);

interface Arranged {
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
  const provider = entry.provider;

  const proveTransportIsSyncing = makeTransportProof(server, provider, docName, DOM_WAIT.timeout);

  render(<SyncStatusProbe provider={provider} docName={docName} />);
  await waitForTransport('the first sync', () => provider.isSynced, DOM_WAIT.timeout);
  await waitFor(() => expect(shownStatus()).toBe('synced'), DOM_WAIT);
  await proveTransportIsSyncing();

  driveHalfOpenForcedClose(provider);
  await waitForTransport(
    'the socket to reconnect',
    () => socketStatus(provider) === 'connected',
    DOM_WAIT.timeout,
  );
  await proveTransportIsSyncing();

  return { proveTransportIsSyncing };
}

test('the editor reads synced again once the transport re-handshakes', async () => {
  await arrangeForcedCloseAndReconnect();

  await waitFor(() => expect(shownStatus()).toBe('synced'), DOM_WAIT);
});

test('the outage toast is retired once edits are reaching the server again', async () => {
  const { proveTransportIsSyncing } = await arrangeForcedCloseAndReconnect();

  await proveTransportIsSyncing();
  await waitFor(() => expect(standingToast()?.kind).toBe('success'), DOM_WAIT);

  expect(
    toastLog.some((t) => t.kind === 'warning' && t.duration === Number.POSITIVE_INFINITY),
  ).toBe(true);
  expect(standingToast()?.duration).toBe(3000);
});
