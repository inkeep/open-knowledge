import { randomUUID } from 'node:crypto';
import type { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { pollUntil, type TestServer } from './integration/test-harness';

const PROBE_KEY = 'forced-close-probe';

const STAGE_TIMEOUT_MS = 8_000;

export function socketStatus(provider: HocuspocusProvider): WebSocketStatus {
  return provider.configuration.websocketProvider.status;
}

export async function waitForTransport(
  what: string,
  predicate: () => boolean,
  timeoutMs = STAGE_TIMEOUT_MS,
): Promise<void> {
  await pollUntil(predicate, timeoutMs, 25, what);
}

export function makeTransportProof(
  server: TestServer,
  provider: HocuspocusProvider,
  docName: string,
  timeoutMs: number = STAGE_TIMEOUT_MS,
): () => Promise<void> {
  return async () => {
    const marker = `alive-${randomUUID()}`;
    provider.document.getText(PROBE_KEY).insert(0, marker);
    await waitForTransport(
      `the server to receive ${marker}`,
      () => {
        const serverDoc = server.instance.hocuspocus.documents.get(docName);
        return serverDoc?.getText(PROBE_KEY).toString().includes(marker) ?? false;
      },
      timeoutMs,
    );
  };
}

export function driveHalfOpenForcedClose(provider: HocuspocusProvider): void {
  const socket = provider.configuration.websocketProvider;
  if (socket.status !== 'connected') {
    throw new Error(`expected a connected socket to force-close, got "${socket.status}"`);
  }
  socket.lastMessageReceived = Date.now() - (socket.configuration.messageReconnectTimeout + 1_000);
  socket.checkConnection();
  socket.checkConnection();
  socket.checkConnection();
  if (socket.status === 'connected') {
    throw new Error(
      'the forced-close branch did not reach the socket teardown, so every test built ' +
        'on this helper is now arranging nothing. Two upstream causes to check: ' +
        '`checkConnection` has changed shape, or `HocuspocusProviderWebsocket` no longer ' +
        'subscribes its own `onClose` to `close` in its constructor, which is what makes ' +
        'the patched `emit("close")` run that teardown.',
    );
  }
}
