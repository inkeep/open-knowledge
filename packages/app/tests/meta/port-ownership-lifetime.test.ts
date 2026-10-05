import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  type AddressInfo,
  createServer as createNetServer,
  type Server,
  type Socket,
} from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { getFreePort } from '../free-port.test-helper.ts';
import { probeOwnedEndpoint } from '../stress/_helpers/port-ownership/run-case.test-helper.ts';

interface HandlerOptions {
  pid: number | null | undefined;
  sendSignal: (pid: number, signal: string) => void;
  exit: (code: number) => void;
  schedule: (callback: () => void, ms: number) => { unref: () => void };
  cleanup: () => void;
  record: (event: string, values?: { message: string }) => void;
}

const require_ = createRequire(import.meta.url);
const { createOwnerLossHandler, OWNER_EXIT_FALLBACK_MS } = require_(
  '../stress/_helpers/port-ownership/owner-lifetime.cjs',
) as {
  createOwnerLossHandler: (options: HandlerOptions) => () => void;
  OWNER_EXIT_FALLBACK_MS: number;
};

function makeRecorder(pid: number | null | undefined) {
  const sends: Array<{ pid: number; signal: string }> = [];
  const exits: number[] = [];
  const records: string[] = [];
  const deadlines: number[] = [];
  let scheduled: (() => void) | undefined;
  let unrefCount = 0;
  let cleanupCount = 0;
  const handle = createOwnerLossHandler({
    pid,
    sendSignal: (target, signal) => sends.push({ pid: target, signal }),
    exit: (code) => exits.push(code),
    schedule: (callback, ms) => {
      scheduled = callback;
      deadlines.push(ms);
      return {
        unref: () => {
          unrefCount += 1;
        },
      };
    },
    cleanup: () => {
      cleanupCount += 1;
    },
    record: (event) => records.push(event),
  });
  return {
    handle,
    sends,
    exits,
    records,
    deadlines,
    scheduled: () => scheduled,
    unrefCount: () => unrefCount,
    cleanupCount: () => cleanupCount,
  };
}

describe('nested runner owner control', () => {
  test('a valid current process receives one termination request and retains a bounded exit fallback', () => {
    const run = makeRecorder(2007);
    run.handle();
    run.handle();
    expect(run.sends).toEqual([{ pid: 2007, signal: 'SIGTERM' }]);
    expect(run.records).toEqual(['owner-control-closed']);
    expect(run.cleanupCount()).toBe(1);
    expect(run.exits).toEqual([]);
    expect(run.deadlines).toEqual([OWNER_EXIT_FALLBACK_MS]);
    expect(run.unrefCount()).toBe(1);
    run.scheduled()?.();
    expect(run.exits).toEqual([0]);
  });

  test.each([null, undefined, 0, 1, -1, Number.NaN, 1.5])(
    'an invalid process target %s never reaches the signal seam',
    (pid) => {
      const run = makeRecorder(pid);
      run.handle();
      run.handle();
      expect(run.sends).toEqual([]);
      expect(run.exits).toEqual([0]);
      expect(run.cleanupCount()).toBe(1);
    },
  );

  test('a failed termination request exits the current process after recording the failure', () => {
    const records: string[] = [];
    const exits: number[] = [];
    const handle = createOwnerLossHandler({
      pid: 2007,
      sendSignal: () => {
        throw new Error('send refused');
      },
      exit: (code) => exits.push(code),
      schedule: () => ({ unref: () => {} }),
      cleanup: () => {},
      record: (event) => records.push(event),
    });
    handle();
    expect(records).toEqual(['owner-control-closed', 'owner-signal-error']);
    expect(exits).toEqual([0]);
  });

  test('a failed diagnostic write cannot prevent the current process termination request', () => {
    const sends: Array<{ pid: number; signal: string }> = [];
    const exits: number[] = [];
    const handle = createOwnerLossHandler({
      pid: 2007,
      sendSignal: (pid, signal) => {
        sends.push({ pid, signal });
      },
      exit: (code) => {
        exits.push(code);
      },
      schedule: () => ({ unref: () => {} }),
      cleanup: () => {
        throw new Error('scratch already removed');
      },
      record: () => {
        throw new Error('event directory already removed');
      },
    });
    handle();
    handle();
    expect(sends).toEqual([{ pid: 2007, signal: 'SIGTERM' }]);
    expect(exits).toEqual([]);
  });
});

describe('owned endpoint probe', () => {
  const OWNED_NONCE = 'owned-endpoint-nonce';
  const openServers: Server[] = [];
  const acceptedSockets = new Set<Socket>();

  async function listenOnLoopback(server: Server): Promise<number> {
    openServers.push(server);
    server.on('connection', (socket: Socket) => {
      acceptedSockets.add(socket);
      socket.once('close', () => acceptedSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    for (const socket of acceptedSockets) socket.destroy();
    acceptedSockets.clear();
    await Promise.all(
      openServers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  test('a listener answering the owned nonce is serving', async () => {
    const port = await listenOnLoopback(
      createHttpServer((_request, response) => response.end(OWNED_NONCE)),
    );
    expect(await probeOwnedEndpoint({ port, nonce: OWNED_NONCE })).toBe(true);
  });

  test('a released port that refuses connections is not serving', async () => {
    const port = await getFreePort();
    expect(await probeOwnedEndpoint({ port, nonce: OWNED_NONCE })).toBe(false);
  });

  test('a bound listener that never answers within the probe bound is still serving', async () => {
    const port = await listenOnLoopback(createNetServer());
    expect(await probeOwnedEndpoint({ port, nonce: OWNED_NONCE })).toBe(true);
  });

  test('a bound listener that drops accepted connections is still serving', async () => {
    const port = await listenOnLoopback(createNetServer((socket) => socket.destroy()));
    expect(await probeOwnedEndpoint({ port, nonce: OWNED_NONCE })).toBe(true);
  });

  test('a listener answering a different identity is not the owned server', async () => {
    const port = await listenOnLoopback(
      createHttpServer((_request, response) => response.end('another-server')),
    );
    expect(await probeOwnedEndpoint({ port, nonce: OWNED_NONCE })).toBe(false);
  });
});
