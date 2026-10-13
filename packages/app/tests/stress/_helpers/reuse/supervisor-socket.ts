import { lstatSync, mkdirSync, type Stats, unlinkSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type ClientMessage,
  type LeaseOutcome,
  type LeaseRequest,
  type LeaseVerdict,
  parseClientMessage,
  parseLeaseOutcome,
  parseLeaseVerdict,
  parseServerMessage,
  type ServerMessage,
} from './lease-protocol.ts';
import type { WorkerServerSupervisor } from './server-supervisor.ts';

export type EndpointClosed =
  | { readonly released: true }
  | { readonly released: false; readonly failure: string };

export interface SupervisorEndpoint {
  readonly socketPath: string;
  readonly closed: Promise<EndpointClosed>;
  close(): Promise<void>;
}

type SocketPathState = 'live' | 'stale' | 'gone';

function probeSocketPath(socketPath: string): Promise<SocketPathState> {
  return new Promise((resolve, reject) => {
    const probe = connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve('live');
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve('stale');
      else if (error.code === 'ENOENT') resolve('gone');
      else {
        reject(
          new Error(
            `cannot claim ${socketPath}: connecting to it failed with ${error.code ?? error.message}, so it is neither a live supervisor nor a stale socket`,
          ),
        );
      }
    });
  });
}

function describeEntry(entry: Stats): string {
  if (entry.isFile()) return 'a regular file';
  if (entry.isDirectory()) return 'a directory';
  if (entry.isSymbolicLink()) return 'a symbolic link';
  if (entry.isFIFO()) return 'a FIFO';
  if (entry.isCharacterDevice()) return 'a character device';
  if (entry.isBlockDevice()) return 'a block device';
  return 'an entry of another kind';
}

function unsafeDirectory(directory: string): string | undefined {
  const entry = lstatSync(directory);
  if (entry.isSymbolicLink()) return 'is a symbolic link';
  const uid = process.getuid?.();
  if (uid !== undefined && entry.uid !== uid) {
    return `is owned by uid ${entry.uid}, not by this process's uid ${uid}`;
  }
  if ((entry.mode & 0o022) !== 0) {
    return `is group- or world-writable (mode ${(entry.mode & 0o777).toString(8).padStart(4, '0')})`;
  }
  return undefined;
}

async function claimSocketPath(socketPath: string): Promise<void> {
  const directory = dirname(socketPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const unsafe = unsafeDirectory(directory);
  if (unsafe !== undefined) {
    throw new Error(
      `cannot claim ${socketPath}: its directory ${directory} ${unsafe}, so another user could replace the socket`,
    );
  }
  const entry = lstatSync(socketPath, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (!entry.isSocket()) {
    throw new Error(`cannot claim ${socketPath}: it is ${describeEntry(entry)}, not a socket`);
  }
  const state = await probeSocketPath(socketPath);
  if (state === 'live') throw new Error(`another supervisor already serves ${socketPath}`);
  if (state === 'stale') unlinkSync(socketPath);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function serveSupervisor(
  supervisor: WorkerServerSupervisor,
  socketPath: string,
): Promise<SupervisorEndpoint> {
  await claimSocketPath(socketPath);
  const connections = new Set<Socket>();
  let resolveClosed: (outcome: EndpointClosed) => void = () => {};
  const closed = new Promise<EndpointClosed>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | undefined;

  const server = createServer((socket) => {
    connections.add(socket);
    const held = new Set<string>();
    let open = true;
    const send = (message: ServerMessage) => {
      if (open) socket.write(`${JSON.stringify(message)}\n`);
    };
    const answer = async (message: ClientMessage): Promise<unknown> => {
      switch (message.op) {
        case 'acquire': {
          const outcome = await supervisor.acquire(message.request);
          if (outcome.kind !== 'granted') return outcome;
          if (!open) {
            await supervisor.abandon(outcome.token);
            return outcome;
          }
          held.add(outcome.token);
          return outcome;
        }
        case 'verify':
          return held.has(message.token)
            ? supervisor.verify(message.token)
            : { held: false, reason: 'the lease is not held by this connection' };
        case 'release':
          if (held.delete(message.token)) await supervisor.release(message.token, message.discard);
          return null;
        case 'status':
          return supervisor.status();
        case 'shutdown':
          return null;
      }
    };
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on('error', () => {});
    lines.on('line', (line) => {
      let message: ClientMessage;
      try {
        message = parseClientMessage(line);
      } catch (error) {
        send({ id: 0, ok: false, error: `malformed request: ${describe(error)}` });
        return;
      }
      answer(message).then(
        (result) => {
          send({ id: message.id, ok: true, result });
          if (message.op === 'shutdown') void endpoint.close();
        },
        (error: unknown) => send({ id: message.id, ok: false, error: describe(error) }),
      );
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      open = false;
      connections.delete(socket);
      for (const token of held) void supervisor.abandon(token);
      held.clear();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: socketPath }, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const endpoint: SupervisorEndpoint = {
    socketPath,
    closed,
    close: () => {
      closing ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of connections) socket.end();
        });
        try {
          await supervisor.shutdown();
          resolveClosed({ released: true });
        } catch (error) {
          const failure = describe(error);
          console.warn(`[server reuse] ${failure}`);
          resolveClosed({ released: false, failure });
        }
      })();
      return closing;
    },
  };
  return endpoint;
}

export interface LeaseClient {
  acquire(request: LeaseRequest, timeoutMs: number): Promise<LeaseOutcome>;
  verify(token: string, timeoutMs: number): Promise<LeaseVerdict>;
  release(token: string, discard: boolean, timeoutMs: number): Promise<void>;
  status(timeoutMs: number): Promise<unknown>;
  shutdown(timeoutMs: number): Promise<void>;
  close(): void;
}

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function connectLeaseClient(socketPath: string, timeoutMs: number): Promise<LeaseClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let failure: Error | undefined;
    const failAll = (error: Error) => {
      failure ??= error;
      for (const [id, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
        pending.delete(id);
      }
    };
    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the supervisor at ${socketPath} did not accept within ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('error', (error) => {
      clearTimeout(connectTimer);
      failAll(error);
      reject(new Error(`the supervisor at ${socketPath} is not reachable: ${error.message}`));
    });
    socket.once('close', () =>
      failAll(new Error(`the supervisor at ${socketPath} closed the lease connection`)),
    );
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on('error', () => {});
    lines.on('line', (line) => {
      let message: ServerMessage;
      try {
        message = parseServerMessage(line);
      } catch (error) {
        failAll(new Error(`the supervisor sent a malformed response: ${describe(error)}`));
        socket.destroy();
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(`the supervisor refused the request: ${message.error}`));
    });

    const call = (body: Record<string, unknown>, callTimeoutMs: number): Promise<unknown> => {
      if (failure !== undefined) return Promise.reject(failure);
      const id = nextId++;
      return new Promise((resolveCall, rejectCall) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(
            new Error(`the supervisor did not answer ${String(body.op)} within ${callTimeoutMs}ms`),
          );
        }, callTimeoutMs);
        pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
        socket.write(`${JSON.stringify({ id, ...body })}\n`);
      });
    };

    socket.once('connect', () => {
      clearTimeout(connectTimer);
      resolve({
        acquire: async (request, ms) =>
          parseLeaseOutcome(await call({ op: 'acquire', request }, ms)),
        verify: async (token, ms) => parseLeaseVerdict(await call({ op: 'verify', token }, ms)),
        release: async (token, discard, ms) => {
          await call({ op: 'release', token, discard }, ms);
        },
        status: (ms) => call({ op: 'status' }, ms),
        shutdown: async (ms) => {
          await call({ op: 'shutdown' }, ms);
        },
        close: () => socket.end(),
      });
    });
  });
}
