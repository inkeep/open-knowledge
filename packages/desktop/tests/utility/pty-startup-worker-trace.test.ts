import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnvironmentData, setEnvironmentData, Worker } from 'node:worker_threads';
import { describe, expect, test, vi } from 'vitest';
import {
  createPtyHostProbe,
  type HarnessSpawn,
  harnessTimeouts,
  runHarness,
} from '../support/pty-readiness.test-helper.ts';
import {
  createPtyStartupWorkerContext,
  PTY_STARTUP_WORKER_CONTEXT,
} from '../support/pty-startup-trace.test-helper.ts';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper.ts';

const requireFromDesktop = createRequire(new URL('../../package.json', import.meta.url));
const workerFile = join(
  dirname(requireFromDesktop.resolve('node-pty')),
  'worker/conoutSocketWorker.js',
);
const preload = new URL('../support/pty-startup-trace-preload.test-helper.mjs', import.meta.url)
  .href;
const harnessFile = fileURLToPath(new URL('./pty-host.real-io-harness.ts', import.meta.url));
const PERSISTED_RECORDS = 10;
const HARNESS_TIMEOUTS = harnessTimeouts(process.platform);
const NATIVE_BYTES = 0;
const SUBMITTED_BYTES = 1;
const WRITER_ERROR = 8;
const CAPTURE_INSTALLED = 9;
const NATIVE_ERROR = 6;
const FORWARDING_ERROR = 7;

interface WorkerFixture {
  worker: Worker;
  native: Socket;
  forwarded: Socket;
  pipe: string;
  server: Server;
  dir: string;
  close(): Promise<void>;
}

async function openWorkerFixture(
  withPreload: boolean,
  socketErrorSeam = false,
): Promise<WorkerFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'ok-pty-worker-trace-'));
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ok-pty-worker-trace-${randomUUID()}`
      : join(dir, 'native');
  const server = createServer();
  let worker: Worker | undefined;
  let native: Socket | undefined;
  let forwarded: Socket | undefined;
  try {
    server.listen(pipe);
    await once(server, 'listening');
    worker = new Worker(
      socketErrorSeam
        ? new URL('../support/pty-startup-socket-error.test-helper.mjs', import.meta.url)
        : workerFile,
      {
        workerData: { conoutPipeName: pipe, workerFile },
        execArgv: withPreload ? ['--import', preload] : [],
      },
    );
    const [[accepted], [message]] = await Promise.all([
      (once(server, 'connection') as Promise<[Socket]>).then((result) => {
        native = result[0];
        return result;
      }),
      Promise.race([
        once(worker, 'message'),
        once(worker, 'exit').then(([code]) => {
          throw new Error(`ConPTY worker exited before READY: ${code}`);
        }),
      ]),
    ]);
    native = accepted;
    expect(message).toBe(1);
    forwarded = connect(`${pipe}-worker`);
    await once(forwarded, 'connect');
    return {
      worker,
      native,
      forwarded,
      pipe,
      server,
      dir,
      async close() {
        forwarded.destroy();
        native.destroy();
        await worker.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    forwarded?.destroy();
    native?.destroy();
    if (worker) await worker.terminate();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function receiveExact(socket: Socket, expected: Buffer, send: () => void): Promise<void> {
  const received = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length < expected.length) return;
      socket.off('data', onData);
      socket.off('error', reject);
      resolve(Buffer.concat(chunks));
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  send();
  expect(await received).toEqual(expected);
}

async function waitForCount(state: BigInt64Array, index: number, count: bigint): Promise<void> {
  while (true) {
    const observed = Atomics.load(state, index);
    if (observed >= count) return;
    const result = await Atomics.waitAsync(
      state,
      index,
      observed,
      HARNESS_TIMEOUTS.verdictDeadlineMs,
    ).value;
    if (result === 'timed-out') throw new Error('ConPTY worker diagnostic count did not advance');
  }
}

async function waitForRecord(output: string, state: BigInt64Array, stage: string): Promise<void> {
  while (true) {
    const observed = Atomics.load(state, PERSISTED_RECORDS);
    const records = readFileSync(output, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('PTY_HOST info '))
      .map((line) => JSON.parse(line.slice('PTY_HOST info '.length)) as { stage: string });
    if (records.some((record) => record.stage === stage)) return;
    const result = await Atomics.waitAsync(
      state,
      PERSISTED_RECORDS,
      observed,
      HARNESS_TIMEOUTS.verdictDeadlineMs,
    ).value;
    if (result === 'timed-out')
      throw new Error(`ConPTY worker milestone did not persist: ${stage}`);
  }
}

function traceContext(outputFd?: number) {
  return createPtyStartupWorkerContext(
    {
      traceId: 17,
      attempt: 2,
      startedAt: performance.timeOrigin + performance.now(),
      backend: 'bundled',
      emit() {},
    },
    outputFd,
  );
}

async function withWorkerContext<T>(value: unknown, run: () => Promise<T>): Promise<T> {
  const previous = getEnvironmentData(PTY_STARTUP_WORKER_CONTEXT);
  setEnvironmentData(PTY_STARTUP_WORKER_CONTEXT, value);
  try {
    return await run();
  } finally {
    setEnvironmentData(PTY_STARTUP_WORKER_CONTEXT, previous);
  }
}

describe('startup trace on the installed ConPTY output worker', () => {
  test.each([false, true])(
    'preserves pre-READY native connection failure with preload %s',
    async (withPreload) => {
      const dir = mkdtempSync(join(tmpdir(), 'ok-pty-worker-missing-'));
      const pipe =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\ok-pty-worker-missing-${randomUUID()}`
          : join(dir, 'missing');
      const context = traceContext();
      let worker: Worker | undefined;
      try {
        await withWorkerContext(context, async () => {
          worker = new Worker(workerFile, {
            workerData: { conoutPipeName: pipe },
            execArgv: withPreload ? ['--import', preload] : [],
          });
          const errors: Error[] = [];
          const messages: unknown[] = [];
          worker.on('error', (error) => errors.push(error));
          worker.on('message', (message) => messages.push(message));
          const exitCode = await new Promise<number>((resolve) => worker.once('exit', resolve));
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({ code: 'ENOENT' });
          expect(exitCode).toBe(1);
          expect(messages).toEqual([]);
          expect(Atomics.load(new BigInt64Array(context.counters), NATIVE_ERROR)).toBe(
            withPreload ? 1n : 0n,
          );
        });
      } finally {
        if (worker) await worker.terminate();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.each([
    { surface: 'native', counter: NATIVE_ERROR, withPreload: false },
    { surface: 'native', counter: NATIVE_ERROR, withPreload: true },
    { surface: 'forwarding', counter: FORWARDING_ERROR, withPreload: false },
    { surface: 'forwarding', counter: FORWARDING_ERROR, withPreload: true },
  ])(
    'preserves $surface transport failure with preload $withPreload',
    async ({ surface, counter, withPreload }) => {
      const context = traceContext();
      let fixture: WorkerFixture | undefined;
      try {
        await withWorkerContext(context, async () => {
          fixture = await openWorkerFixture(withPreload, true);
        });
        const payload = Buffer.from('output-error-control');
        await receiveExact(fixture.forwarded, payload, () => fixture.native.write(payload));
        const worker = fixture.worker;
        const exited = new Promise<number>((resolve) => worker.once('exit', resolve));
        const outcome = new Promise<unknown>((resolve) => {
          worker.once('error', (error) => resolve({ kind: 'error', message: error.message }));
          worker.once('message', (message) => resolve({ kind: 'message', message }));
        });
        worker.postMessage(surface);
        expect(await outcome).toEqual({ kind: 'error', message: 'owned output socket failed' });
        expect(await exited).toBe(1);
        expect(Atomics.load(new BigInt64Array(context.counters), counter)).toBe(
          withPreload ? 1n : 0n,
        );
      } finally {
        await fixture?.close();
      }
    },
  );

  test('counts raw native bytes and submitted worker bytes across split multibyte input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-pty-worker-log-'));
    const output = join(dir, 'trace.log');
    const fd = openSync(output, 'w');
    const context = traceContext(fd);
    let fixture: WorkerFixture | undefined;
    try {
      await withWorkerContext(context, async () => {
        fixture = await openWorkerFixture(true);
      });
      const bytes = Buffer.from('AλB語C');
      const state = new BigInt64Array(context.counters);
      expect(Atomics.load(state, CAPTURE_INSTALLED)).toBe(1n);
      const received = receiveExact(fixture.forwarded, bytes, () =>
        fixture.native.write(bytes.subarray(0, 2)),
      );
      await waitForCount(state, NATIVE_BYTES, 2n);
      fixture.native.write(bytes.subarray(2, 5));
      await waitForCount(state, NATIVE_BYTES, 5n);
      fixture.native.write(bytes.subarray(5));
      await received;
      await waitForCount(state, SUBMITTED_BYTES, BigInt(bytes.length));
      await waitForRecord(output, state, 'worker-first-submit');
      expect(Number(Atomics.load(state, NATIVE_BYTES))).toBe(bytes.length);
      expect(Number(Atomics.load(state, SUBMITTED_BYTES))).toBe(bytes.length);
      const malformed = Buffer.from([0xff, 0x58]);
      const reencoded = Buffer.from('�X');
      await receiveExact(fixture.forwarded, reencoded, () => fixture.native.write(malformed));
      await waitForCount(state, NATIVE_BYTES, BigInt(bytes.length + malformed.length));
      await waitForCount(state, SUBMITTED_BYTES, BigInt(bytes.length + reencoded.length));
      expect(Number(Atomics.load(state, NATIVE_BYTES))).toBe(bytes.length + malformed.length);
      expect(Number(Atomics.load(state, SUBMITTED_BYTES))).toBe(bytes.length + reencoded.length);
      expect(Atomics.load(state, CAPTURE_INSTALLED)).toBe(1n);
      expect(Atomics.load(state, WRITER_ERROR)).toBe(0n);
      const records = readFileSync(output, 'utf8');
      expect(records).toContain('"stage":"worker-ready-sent"');
      expect(records).toContain('"stage":"worker-native-first-read"');
      expect(records).toContain('"stage":"worker-first-submit"');
      expect(records).not.toContain('AλB語C');
      expect(records).not.toContain(fixture.pipe);
      const events = records
        .split('\n')
        .filter((line) => line.startsWith('PTY_HOST info '))
        .map(
          (line) =>
            JSON.parse(line.slice('PTY_HOST info '.length)) as {
              traceId: number;
              attempt: number;
              producer: string;
              stage: string;
              sequence: number;
            },
        );
      for (const entry of events) {
        expect(entry.traceId).toBe(context.traceId);
        expect(entry.attempt).toBe(context.attempt);
        expect(entry.producer).toBe('conout-worker');
      }
      expect(new Set(events.map((entry) => entry.stage)).size).toBe(events.length);
      expect(events.map((entry) => entry.sequence)).toEqual(
        events.map((_entry, index) => index + 1),
      );
    } finally {
      await fixture?.close();
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps transport functional without preload while the diagnostic count stays absent', async () => {
    const context = traceContext();
    let fixture: WorkerFixture | undefined;
    try {
      await withWorkerContext(context, async () => {
        fixture = await openWorkerFixture(false);
      });
      const payload = Buffer.from('worker-control-λ');
      await receiveExact(fixture.forwarded, payload, () => fixture.native.write(payload));
      const state = new BigInt64Array(context.counters);
      expect(Atomics.load(state, CAPTURE_INSTALLED)).toBe(0n);
      expect(Atomics.load(state, NATIVE_BYTES)).toBe(0n);
      expect(Atomics.load(state, SUBMITTED_BYTES)).toBe(0n);
    } finally {
      await fixture?.close();
    }
  });

  test('leaves a worker without trace context uninstrumented', async () => {
    let fixture: WorkerFixture | undefined;
    let identityWorker: Worker | undefined;
    try {
      await withWorkerContext(undefined, async () => {
        fixture = await openWorkerFixture(true);
      });
      const payload = Buffer.from('worker-without-context');
      await receiveExact(fixture.forwarded, payload, () => fixture.native.write(payload));
      await withWorkerContext(undefined, async () => {
        identityWorker = new Worker(
          new URL('../support/pty-startup-trace-state.test-helper.mjs', import.meta.url),
          { workerData: { conoutPipeName: fixture.pipe }, execArgv: [] },
        );
      });
      expect((await once(identityWorker, 'message'))[0]).toEqual({
        connectUnchanged: true,
        serverUnchanged: true,
      });
    } finally {
      if (identityWorker) await identityWorker.terminate();
      await fixture?.close();
    }
  });

  test('persists a worker milestone to a regular file while the main event loop is blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-pty-worker-blocked-'));
    const output = join(dir, 'trace.log');
    const fd = openSync(output, 'w');
    const context = traceContext(fd);
    const state = new BigInt64Array(context.counters);
    let worker: Worker | undefined;
    try {
      await withWorkerContext(context, async () => {
        worker = new Worker(workerFile, {
          workerData: { conoutPipeName: join(dir, 'unreachable-native') },
          execArgv: ['--import', preload],
        });
        worker.once('error', () => undefined);
      });
      const result = Atomics.wait(state, PERSISTED_RECORDS, 0n, HARNESS_TIMEOUTS.verdictDeadlineMs);
      expect(result).not.toBe('timed-out');
      expect(readFileSync(output, 'utf8')).toContain('"stage":"worker-preload-installed"');
    } finally {
      if (worker) await worker.terminate();
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks direct-file failure without changing worker transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-pty-worker-readonly-'));
    const output = join(dir, 'trace.log');
    const fd = openSync(output, 'w');
    closeSync(fd);
    const readonlyFd = openSync(output, 'r');
    const context = traceContext(readonlyFd);
    let fixture: WorkerFixture | undefined;
    try {
      await withWorkerContext(context, async () => {
        fixture = await openWorkerFixture(true);
      });
      const payload = Buffer.from('read-only-log-λ');
      await receiveExact(fixture.forwarded, payload, () => fixture.native.write(payload));
      const state = new BigInt64Array(context.counters);
      await waitForCount(state, SUBMITTED_BYTES, BigInt(payload.length));
      expect(Atomics.load(state, CAPTURE_INSTALLED)).toBe(1n);
      expect(Atomics.load(state, WRITER_ERROR)).toBe(1n);
      expect(readFileSync(output, 'utf8')).toBe('');
    } finally {
      await fixture?.close();
      closeSync(readonlyFd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startup trace wrapper', () => {
  test('launches the harness with its worker preload and retains diagnostic records on failure', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'ok-pty-trace-wrapper-'));
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      kill: vi.fn(() => emitter.emit('exit', 0, null)),
      unref: vi.fn(),
    });
    const spawnChild = vi.fn<HarnessSpawn>((_file, _args, options) => {
      const fd = Array.isArray(options.stdio) ? options.stdio.at(1) : undefined;
      if (typeof fd !== 'number')
        throw new Error('fixture requires the actual output file descriptor');
      const host = createPtyHostProbe({
        spawn: () => {
          throw new Error('fixture shell did not start');
        },
        platform: 'darwin',
        env: { SHELL: '/fixture-shell' },
        shellExists: () => true,
        startupTrace: {},
        logger: {
          warn: (entry) => writeSync(fd, `PTY_HOST warn ${JSON.stringify(entry)}\n`),
          info: (entry) => writeSync(fd, `PTY_HOST info ${JSON.stringify(entry)}\n`),
        },
      });
      host.send({ type: 'create', ptyId: 'wrapper-fixture', cwd: outputDir, cols: 80, rows: 24 });
      writeSync(
        fd,
        `FAIL fixture :: ${host.errorOf('wrapper-fixture')}\nHARNESS_RESULT ok=0 fail=1 refused=0\n`,
      );
      host.killActive();
      return child;
    });
    try {
      const failure = await runHarness(outputDir, {}, spawnChild).then(
        () => 'unexpected success',
        (error: Error) => error.message,
      );
      expect(failure).toContain('real-PTY harness reported failure:');
      expect(failure).toContain('FAIL fixture :: fixture shell did not start');
      const trace = failure
        .split('\n')
        .filter((line) => line.startsWith('PTY_HOST info '))
        .map((line) => JSON.parse(line.slice('PTY_HOST info '.length)))
        .filter((entry) => entry.event === 'pty-host-startup');
      expect(trace.map((entry) => entry.stage)).toEqual([
        'lookup-start',
        'lookup-complete',
        'spawn-start',
        'spawn-failed',
      ]);
      expect(JSON.stringify(trace)).not.toContain('wrapper-fixture');
      expect(JSON.stringify(trace)).not.toContain(outputDir);
      expect(spawnChild.mock.calls.at(0)?.slice(0, 2)).toEqual([
        process.execPath,
        ['--import', preload, harnessFile],
      ]);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      removeTempDirBestEffort(outputDir);
    }
  });
});
