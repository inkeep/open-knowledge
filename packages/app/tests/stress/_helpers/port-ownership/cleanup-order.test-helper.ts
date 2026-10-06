import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const SOURCE = fileURLToPath(new URL('./cleanup-order.c', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./cleanup-order-preload.cjs', import.meta.url));

export async function createCleanupOrder(
  outputDir: string,
  purpose: 'owner-loss' | 'control' = 'owner-loss',
) {
  const nativeOrdering =
    purpose === 'owner-loss' && (process.platform === 'darwin' || process.platform === 'linux');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, 'capabilities.json'),
    JSON.stringify({ platform: process.platform, nativeOrdering }),
  );
  const library = join(outputDir, process.platform === 'darwin' ? 'order.dylib' : 'order.so');
  if (nativeOrdering) {
    try {
      await execute('cc', [
        '-Wall',
        '-Wextra',
        '-Werror=implicit-function-declaration',
        '-Werror=implicit-int',
        '-Werror=int-conversion',
        '-Werror=incompatible-pointer-types',
        '-Werror=format',
        '-Werror=return-type',
        ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-fPIC']),
        SOURCE,
        '-o',
        library,
        ...(process.platform === 'linux' ? ['-ldl'] : []),
      ]);
    } catch (error) {
      throw new Error(
        `native cleanup ordering needs a C compiler on PATH as cc (Xcode Command Line Tools on macOS, gcc on Linux) to build ${SOURCE}`,
        { cause: error },
      );
    }
  }

  const clients = new Set<Socket>();
  const held = new Map<string, Socket>();
  const seen = new Set<string>();
  const ended = new Set<number>();
  const yielded = new Set<number>();
  const events: Array<{ phase: string; pid: number }> = [];
  const arrivals = new Map<string, () => void>();
  const removers = new Set<number>();
  let runner: number | undefined;
  let server: number | undefined;
  let readyResolve: ((error?: Error) => void) | undefined;
  const ready = new Promise<Error | undefined>((resolve) => {
    readyResolve = resolve;
  });
  const key = (phase: string, pid: number | undefined) => `${phase}:${pid}`;
  const has = (phase: string, pid: number | undefined) => seen.has(key(phase, pid));
  const advanced = (pid: number | undefined) =>
    pid !== undefined && (ended.has(pid) || yielded.has(pid));
  function release(phase: string, pid: number | undefined) {
    const id = key(phase, pid);
    const socket = held.get(id);
    if (!socket) return;
    held.delete(id);
    socket.end('!');
    events.push({ phase: `ack:${phase}`, pid: Number(pid) });
  }
  function advance() {
    if (runner !== undefined && server !== undefined) readyResolve?.();
    if (removers.size > 0 || advanced(runner)) release('before-record', server);
    if ([...removers].some((pid) => has('before-error', pid)) || advanced(runner)) {
      release('after-record', server);
    }
    for (const pid of removers) {
      if (pid === server) {
        if (
          [...removers].some((other) => other !== server && has('after-error', other)) ||
          advanced(runner)
        ) {
          release('remove', pid);
        }
      } else {
        if (has('after-record', server) || has('remove', server) || advanced(server))
          release('remove', pid);
        if (has('remove', server) || advanced(server)) release('before-error', pid);
      }
    }
  }
  const controller = createServer((socket) => {
    clients.add(socket);
    let buffer = '';
    let actor: number | undefined;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\n')) return;
      const [phase, rawPid] = buffer.trim().split('\t');
      const pid = Number(rawPid);
      if (!phase || !Number.isInteger(pid) || pid <= 1) {
        readyResolve?.(new Error('invalid cleanup ordering participant'));
        socket.destroy();
        return;
      }
      events.push({ phase, pid });
      if (phase === 'runner' || phase === 'server') {
        actor = pid;
        if (phase === 'runner') runner = pid;
        else server = pid;
      } else {
        const id = key(phase, pid);
        seen.add(id);
        held.set(id, socket);
        arrivals.get(id)?.();
        arrivals.delete(id);
        if (phase === 'remove' && runner !== undefined && server !== undefined) removers.add(pid);
        if (phase === 'yield') yielded.add(pid);
        const constrained =
          (pid === server && ['before-record', 'after-record'].includes(phase)) ||
          (phase === 'remove' && removers.has(pid)) ||
          (phase === 'before-error' && pid !== server && removers.has(pid));
        if (!constrained) release(phase, pid);
      }
      advance();
    });
    socket.once('close', () => {
      clients.delete(socket);
      if (actor !== undefined) {
        ended.add(actor);
        events.push({ phase: 'exit', pid: actor });
        if (runner === undefined || server === undefined) {
          readyResolve?.(
            new Error('cleanup ordering participant exited before registration completed'),
          );
        }
      }
      advance();
    });
  });
  await new Promise<void>((resolve, reject) => {
    controller.once('error', reject);
    controller.listen(0, '127.0.0.1', resolve);
  });
  const address = controller.address();
  if (!address || typeof address === 'string') throw new Error('cleanup ordering has no address');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OK_PORT_OWNERSHIP_SCHEDULE_PORT: String(address.port),
    ...(nativeOrdering
      ? {
          OK_PORT_OWNERSHIP_SCHEDULE_LIBRARY: library,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${PRELOAD}`.trim(),
          [process.platform === 'darwin' ? 'DYLD_INSERT_LIBRARIES' : 'LD_PRELOAD']: library,
        }
      : {}),
  };
  async function close() {
    writeFileSync(join(outputDir, 'events.json'), JSON.stringify(events, null, 2));
    for (const socket of held.values()) socket.end('!');
    held.clear();
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve) => controller.close(() => resolve()));
  }
  try {
    if (nativeOrdering) {
      const canary = join(outputDir, 'canary');
      mkdirSync(canary);
      await execute(
        process.execPath,
        [
          '-e',
          'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })',
          canary,
        ],
        { env: { ...env, OK_PORT_OWNERSHIP_SCHEDULE_RUN_DIR: canary } },
      );
      if (!events.some((event) => event.phase === 'remove')) {
        throw new Error('native cleanup ordering did not observe the real removal canary');
      }
    }
    return {
      env,
      nativeOrdering,
      waitForArrival: (phase: string, pid: number) => {
        const id = key(phase, pid);
        return seen.has(id)
          ? Promise.resolve()
          : new Promise<void>((resolve) => arrivals.set(id, resolve));
      },
      beforeOwnerExit: async (pid: number) => {
        const error = await ready;
        if (error) throw error;
        if (server !== pid)
          throw new Error('cleanup ordering did not register the lifetime server');
      },
      events,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
