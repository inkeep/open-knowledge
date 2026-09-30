import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type GhPhase = 'version' | 'auth' | 'lookup' | 'status';

type GhMessage = { phase: GhPhase; event: 'connected' | 'signal'; pid: number };

export async function createControlledGh(options: {
  version: 'park' | 'complete';
  auth: 'park' | 'complete';
  lookup: 'park' | 'complete';
  status?: 'park' | 'complete';
}) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-gh-lifecycle-'));
  const sockets = new Map<Socket, GhPhase>();
  const released = new Set<GhPhase>();
  let cleaningUp = false;
  const messages: GhMessage[] = [];
  const waiters: Array<{
    match: (message: GhMessage) => boolean;
    resolve: (message: GhMessage) => void;
  }> = [];
  const control = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line) as GhMessage;
        if (message.event === 'connected') {
          sockets.set(socket, message.phase);
          if (cleaningUp || released.has(message.phase)) socket.write('release\n');
        }
        messages.push(message);
        const index = waiters.findIndex(({ match }) => match(message));
        if (index >= 0) waiters.splice(index, 1)[0]?.resolve(message);
      }
    });
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const address = control.address();
  if (!address || typeof address === 'string') throw new Error('Missing gh fixture address');

  const executable = join(dir, 'gh');
  const script = `#!${process.execPath}
const net = require('node:net');
const phase = process.argv[2] === '--version' ? 'version' : process.argv[2] === 'api' ? 'lookup' : process.argv[3] === 'status' ? 'status' : 'auth';
const modes = ${JSON.stringify(options)};
const socket = net.connect(${address.port}, '127.0.0.1');
let buffer = '';
function complete() {
  if (phase === 'version') process.stdout.write('gh version 1.0.0\\n');
  if (phase === 'lookup') process.stdout.write('octocat\\n');
  socket.end(() => process.exit(0));
}
socket.on('connect', () => {
  socket.write(JSON.stringify({ phase, event: 'connected', pid: process.pid }) + '\\n', () => {
    if (phase === 'auth') {
      process.stderr.write('First copy your one-time code: WDJB-MJHT\\nhttps://github.com/login/device\\n');
    }
    if (phase === 'status') process.stdout.write(JSON.stringify({ authenticated: false }) + '\\n');
    if (modes[phase] === 'complete') complete();
  });
});
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (buffer.includes('release\\n')) complete();
});
socket.on('error', () => process.exit(1));
process.on('SIGTERM', () => socket.write(JSON.stringify({ phase, event: 'signal', pid: process.pid }) + '\\n', () => socket.end(() => process.exit(0))));
`;
  writeFileSync(executable, script, { flag: 'wx', mode: 0o755 });
  chmodSync(executable, 0o755);

  return {
    dir,
    executable,
    port: address.port,
    messages,
    next: (phase: GhPhase, event: GhMessage['event'] = 'connected') => {
      const found = messages.find((message) => message.phase === phase && message.event === event);
      if (found) return Promise.resolve(found);
      return new Promise<GhMessage>((resolve) => {
        waiters.push({
          match: (message) => message.phase === phase && message.event === event,
          resolve,
        });
      });
    },
    release: (phase: GhPhase) => {
      released.add(phase);
      for (const [socket, current] of sockets) if (current === phase) socket.write('release\n');
    },
    cleanup: async () => {
      cleaningUp = true;
      for (const socket of sockets.keys()) socket.write('release\n');
      const closed = once(control, 'close');
      control.close();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
