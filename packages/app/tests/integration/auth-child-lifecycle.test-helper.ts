import { ChildProcess } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';

export function observeChildren(command: readonly string[]) {
  const children: { child: ChildProcess; pid: number; closed: Promise<void> }[] = [];
  const listener = (message: unknown): void => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('process' in message) ||
      !(message.process instanceof ChildProcess)
    ) {
      throw new Error('Unexpected child process diagnostic');
    }
    const child = message.process;
    child.once('spawn', () => {
      if (!command.every((arg, index) => child.spawnargs[index] === arg)) return;
      const pid = child.pid;
      if (pid === undefined) throw new Error('Spawned child has no pid');
      children.push({
        child,
        pid,
        closed: new Promise<void>((resolve) => child.once('close', () => resolve())),
      });
    });
  };
  subscribe('child_process', listener);
  return {
    children,
    runningPids: () =>
      children
        .filter(({ child }) => child.exitCode === null && child.signalCode === null)
        .map(({ pid }) => pid),
    stop: () => unsubscribe('child_process', listener),
  };
}

export async function createControlledAuthCli() {
  const sockets = new Set<Socket>();
  const ready = Promise.withResolvers<void>();
  const control = createServer((socket) => {
    sockets.add(socket);
    ready.resolve();
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const address = control.address();
  if (!address || typeof address === 'string') throw new Error('Missing control listener');
  const script = `
    const net = require('node:net');
    process.on('SIGTERM', () => {});
    const socket = net.connect(${address.port}, '127.0.0.1', () => {
      console.log(JSON.stringify({type:'verification', user_code:'WDJB-MJHT', verification_uri:'https://github.com/login/device', expires_in:900}));
      console.error('First copy your one-time code: WDJB-MJHT');
      console.error('https://github.com/login/device');
    });
    socket.once('end', () => process.exit(0));
    socket.once('error', () => process.exit(1));
  `;
  return {
    ready: ready.promise,
    script,
    cliArgs: [process.execPath, '-e', script],
    release: async () => {
      const closed = once(control, 'close');
      control.close();
      for (const socket of sockets) socket.end();
      await closed;
    },
  };
}
