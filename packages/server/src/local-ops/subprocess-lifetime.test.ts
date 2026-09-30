import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { describe, expect, onTestFinished, test } from 'vitest';
import { LocalOpSubprocessLifetime } from './subprocess-lifetime.ts';

const DESCENDANT = `
const socket = require('node:net').connect(Number(process.argv[1]), '127.0.0.1', () => {
  socket.write(process.pid + '\\n');
});
socket.on('error', () => process.exit(0));
socket.on('end', () => process.exit(0));
`;

const CHILD = `
const [port, mode, descendant] = process.argv.slice(1);
require('node:child_process')
  .spawn(process.execPath, ['-e', descendant, port], { stdio: ['ignore', 'inherit', 'inherit'] })
  .once('spawn', () => {
    if (mode === 'exit') process.exit(0);
  });
if (mode === 'stay') {
  const socket = require('node:net').connect(Number(port), '127.0.0.1');
  socket.on('error', () => process.exit(0));
  socket.on('end', () => process.exit(0));
}
`;

interface Descendant {
  pid: number;
  connected(): boolean;
}

interface ReleaseChannel {
  port: number;
  descendant: Promise<Descendant>;
  release(): Promise<void>;
}

interface OwnedRun {
  child: ChildProcess;
  exited: Promise<number | null>;
  closed: Promise<void>;
}

async function openReleaseChannel(): Promise<ReleaseChannel> {
  const held = new Set<{ socket: Socket; closed: Promise<void> }>();
  let releasing = false;
  let connect!: (descendant: Descendant) => void;
  const descendant = new Promise<Descendant>((resolve) => {
    connect = resolve;
  });
  const server = createServer((socket) => {
    let open = true;
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => {
        open = false;
        resolve();
      });
    });
    held.add({ socket, closed });
    socket.on('error', () => {});
    if (releasing) socket.end();
    socket.setEncoding('utf8');
    let received = '';
    socket.on('data', (chunk: string) => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end >= 0) connect({ pid: Number(received.slice(0, end)), connected: () => open });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('The release channel has no port.');
  }
  return {
    port: address.port,
    descendant,
    async release() {
      releasing = true;
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const { socket } of held) socket.end();
      await Promise.all([...held].map(({ closed }) => closed));
      await serverClosed;
    },
  };
}

function launch(
  lifetime: LocalOpSubprocessLifetime,
  channel: ReleaseChannel,
  mode: 'stay' | 'exit',
): OwnedRun {
  const child = lifetime.spawn(() =>
    spawn(process.execPath, ['-e', CHILD, String(channel.port), mode, DESCENDANT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  const run: OwnedRun = {
    child,
    exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    closed: new Promise((resolve) => child.once('close', () => resolve())),
  };
  onTestFinished(async () => {
    await channel.release();
    await run.closed;
  });
  return run;
}

function descendantHoldingOutput(
  channel: ReleaseChannel,
  run: OwnedRun,
  childExits: boolean,
): Promise<Descendant> {
  const exitedFirst = run.exited.then((code) => {
    if (childExits && code === 0) return channel.descendant;
    throw new Error(`The child exited with code ${code} before its descendant connected.`);
  });
  return Promise.race([channel.descendant, exitedFirst]);
}

describe('LocalOpSubprocessLifetime', () => {
  test('shutdown settles after ending a child whose output a descendant still holds', async ({
    annotate,
  }) => {
    const channel = await openReleaseChannel();
    const lifetime = new LocalOpSubprocessLifetime();
    const run = launch(lifetime, channel, 'stay');
    const descendant = await descendantHoldingOutput(channel, run, false);
    await annotate(`child pid ${run.child.pid}, descendant pid ${descendant.pid}`);

    await lifetime.shutdown();

    expect(descendant.connected()).toBe(true);
    expect([run.child.exitCode, run.child.signalCode]).not.toEqual([null, null]);
  });

  test('shutdown settles for an exited child whose output a descendant still holds', async ({
    annotate,
  }) => {
    const channel = await openReleaseChannel();
    const lifetime = new LocalOpSubprocessLifetime();
    const run = launch(lifetime, channel, 'exit');
    const descendant = await descendantHoldingOutput(channel, run, true);
    expect(await run.exited).toBe(0);
    await annotate(`child pid ${run.child.pid}, descendant pid ${descendant.pid}`);

    await lifetime.shutdown();

    expect(descendant.connected()).toBe(true);
  });
});
