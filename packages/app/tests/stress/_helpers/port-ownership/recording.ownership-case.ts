import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import {
  isTestServerHost,
  TEST_SERVER_CANDIDATE_PORTS,
  TEST_SERVER_HOST_FAMILY,
  TEST_SERVER_STARTUP_ENV,
} from '../../../../src/build/test-server-startup-contract.ts';
import { createViteStartupRequest, type ViteStartupRequest } from '../server-process.ts';
import { readOwnershipRecords } from './run-case.test-helper.ts';

async function listen(server: Server, host: string): Promise<number> {
  const { start, end } = TEST_SERVER_CANDIDATE_PORTS;
  const first = randomInt(start, end);
  for (let offset = 0; offset < end - start; offset += 1) {
    const port = start + ((first - start + offset) % (end - start));
    try {
      const listening = once(server, 'listening');
      server.listen(port, host);
      await listening;
      return port;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE')
        throw error;
    }
  }
  throw new Error('no candidate port is available for the recording case');
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

for (const host of Object.keys(TEST_SERVER_HOST_FAMILY).filter(isTestServerHost)) {
  const family = TEST_SERVER_HOST_FAMILY[host];
  for (const [collision, ordering] of Object.entries({
    'an unavailable candidate': {
      candidateSkipped: true,
      candidateContended: false,
      contenderListening: true,
    },
    'a bind contender': {
      candidateSkipped: false,
      candidateContended: true,
      contenderListening: true,
    },
    'a released bind contender': {
      candidateSkipped: false,
      candidateContended: true,
      contenderListening: false,
    },
  })) {
    test(`records ownership evidence after ${collision} on ${family}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ok-recording-'));
      const contender = createNetServer((socket) => socket.destroy());
      const previousRequest = process.env[TEST_SERVER_STARTUP_ENV];
      const originalEmit = Server.prototype.emit;
      let request: ViteStartupRequest | undefined;
      let vite: Awaited<ReturnType<typeof createServer>> | undefined;
      try {
        const candidatePort = await listen(contender, '0.0.0.0');
        if (collision !== 'an unavailable candidate') await close(contender);
        request = createViteStartupRequest(host, candidatePort);
        process.env[TEST_SERVER_STARTUP_ENV] = request.environment[TEST_SERVER_STARTUP_ENV];
        vite = await createServer({
          root,
          configFile: false,
          logLevel: 'silent',
          server: { host, port: candidatePort, strictPort: false, hmr: false },
          optimizeDeps: { noDiscovery: true, include: [] },
        });
        const httpServer = vite.httpServer;
        if (!httpServer) throw new Error('expected an HTTP server');
        if (collision === 'a released bind contender') {
          Server.prototype.emit = function (event, ...values) {
            const error = values[0];
            if (
              event === 'error' &&
              this !== contender &&
              this !== httpServer &&
              contender.listening &&
              error instanceof Error &&
              'code' in error &&
              error.code === 'EADDRINUSE'
            ) {
              Server.prototype.emit = originalEmit;
              contender.close((closeError) => {
                if (closeError) throw closeError;
                Reflect.apply(originalEmit, this, [event, ...values]);
              });
              return true;
            }
            return Reflect.apply(originalEmit, this, [event, ...values]);
          };
        }
        if (collision !== 'an unavailable candidate') {
          const originalListen = httpServer.listen;
          httpServer.listen = (...args) => {
            httpServer.listen = originalListen;
            const port = args[0];
            if (typeof port !== 'number') throw new Error('expected a TCP port');
            contender.once('error', (error) => httpServer.emit('error', error));
            contender.listen(port, host === '::1' ? '::1' : '127.0.0.1', () =>
              Reflect.apply(originalListen, httpServer, args),
            );
            return httpServer;
          };
        }
        await vite.listen();
        const recordsPath = process.env.OK_PORT_OWNERSHIP_RECORDS;
        if (!recordsPath) throw new Error('expected an ownership records path');
        const records = readOwnershipRecords(recordsPath).filter(
          (record): record is Record<string, unknown> =>
            typeof record === 'object' && record !== null,
        );
        const firstAttemptPort = records.find(
          (record) => record.event === 'vite-bind-attempt',
        )?.port;
        expect(firstAttemptPort, JSON.stringify(records)).toEqual(expect.any(Number));
        expect(
          {
            candidateSkipped:
              typeof firstAttemptPort === 'number' && firstAttemptPort > candidatePort,
            candidateContended: records.some(
              (record) =>
                record.event === 'vite-bind-takeover-error' &&
                record.port === candidatePort &&
                record.code === 'EADDRINUSE',
            ),
            contenderListening: contender.listening,
          },
          JSON.stringify(records),
        ).toEqual(ordering);
      } finally {
        Server.prototype.emit = originalEmit;
        await vite?.close();
        await close(contender);
        if (previousRequest === undefined) delete process.env[TEST_SERVER_STARTUP_ENV];
        else process.env[TEST_SERVER_STARTUP_ENV] = previousRequest;
        request?.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
