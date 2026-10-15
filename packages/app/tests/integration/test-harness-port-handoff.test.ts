import { createServer as createHttpServer } from 'node:http';
import { Server } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';

let createdServer: { destroy: () => Promise<unknown> } | undefined;

vi.mock('@inkeep/open-knowledge-server', async () => {
  const actual = await vi.importActual<typeof import('@inkeep/open-knowledge-server')>(
    '@inkeep/open-knowledge-server',
  );
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      createdServer = actual.createServer(...args);
      return createdServer;
    },
  };
});

const { createTestServer } = await import('./test-harness');

const originalClose = Server.prototype.close;
let competitor: ReturnType<typeof createHttpServer> | undefined;
let competitorListening: Promise<Error | undefined> | undefined;
let injected = false;

afterEach(async () => {
  Server.prototype.close = originalClose;
  if (createdServer !== undefined) {
    await createdServer.destroy().catch(() => undefined);
    createdServer = undefined;
  }
  if (competitor !== undefined) {
    await new Promise<void>((resolve) => competitor?.close(() => resolve()));
    competitor = undefined;
  }
  competitorListening = undefined;
  injected = false;
});

test('keeps the selected serving port owned until the app rig binds', async () => {
  Server.prototype.close = function close(callback?: (error?: Error) => void) {
    const address = this.address();
    if (!injected && typeof address === 'object' && address !== null) {
      injected = true;
      return originalClose.call(this, (error?: Error) => {
        const rival = createHttpServer((_request, response) => response.end('competitor'));
        competitor = rival;
        competitorListening = new Promise<Error | undefined>((resolve) => {
          rival.once('error', resolve);
          rival.listen(address.port, '127.0.0.1', () => resolve(undefined));
        });
        void competitorListening.then(() => callback?.(error));
      });
    }
    return originalClose.call(this, callback);
  };

  const server = await createTestServer({ ephemeral: true });
  Server.prototype.close = originalClose;
  const releasedAddressedPortDuringSetup = injected;
  await server.cleanup();
  createdServer = undefined;

  expect(await competitorListening).toBeUndefined();
  expect(releasedAddressedPortDuringSetup).toBe(false);
});
