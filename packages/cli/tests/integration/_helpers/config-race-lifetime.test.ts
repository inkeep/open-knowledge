import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  runConfigWriters,
  type SpawnWriter,
  spawnConfigWriter,
} from './config-race.test-helper.ts';

class ControlledWriter extends EventEmitter {
  stderr = new PassThrough();
  pid: number | undefined = 10_000;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    return true;
  }

  complete() {
    this.exitCode = 0;
    this.emit('exit', 0);
    this.emit('close', 0);
  }

  terminate(signal: NodeJS.Signals) {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
  }
}

function arrangeWriters(count: number, signal?: AbortSignal) {
  const children = Array.from({ length: count }, () => new ControlledWriter());
  const keys = children.map((_, index) => `writer-${index}`);
  const spawnWriter: SpawnWriter = (_path, key) => children[keys.indexOf(key)];
  const result = runConfigWriters('/owned/config.json', keys, { spawnWriter, signal }).then(
    (outcomes) => ({ status: 'passed' as const, outcomes }),
    (error: unknown) => ({ status: 'failed' as const, error }),
  );
  return { children, result };
}

async function failureOf(result: ReturnType<typeof arrangeWriters>['result']) {
  const settled = await result;
  expect(settled.status).toBe('failed');
  return settled.status === 'failed' ? settled.error : undefined;
}

function expectWriterFailure(error: unknown, writer: string, cause: Error) {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(writer);
  expect((error as Error).cause).toBe(cause);
}

function arrangeRealPreparation(options: {
  signal: AbortSignal;
  advanceOnLoad?: boolean;
  hold?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), 'config-race-preparation-'));
  const configPath = join(root, 'config.json');
  const preloadPath = join(root, 'observe-loads.mjs');
  const workerPath = fileURLToPath(new URL('./config-race-worker.ts', import.meta.url));
  const initUrl = new URL('../../../src/commands/init.ts', import.meta.url).href;
  const existing = { command: 'keep-this-command', args: ['keep-this-argument'] };
  writeFileSync(configPath, JSON.stringify({ mcpServers: { existing } }));
  writeFileSync(
    preloadPath,
    `import { registerHooks } from 'node:module';
process.once('disconnect', () => process.exit(70));
const hold = new URL(import.meta.url).searchParams.get('hold');
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    process.send({ type: 'test-module-loaded', url });
    if (url !== hold) return loaded;
    return {
      ...loaded,
      source: \`await new Promise((resolve) => {
        process.on('message', (message) => {
          if (message === 'release-test-module') resolve();
        });
        process.send({ type: 'test-module-held', url: import.meta.url });
      });\` + Buffer.from(loaded.source).toString('utf8'),
    };
  },
});
`,
  );
  const preloadUrl = pathToFileURL(preloadPath);
  if (options.hold) preloadUrl.searchParams.set('hold', initUrl);
  const observed = new Set<string>();
  const reported: string[] = [];
  const premature: string[] = [];
  const closes: { exitCode: number | null; signal: NodeJS.Signals | null }[] = [];
  const entered = Promise.withResolvers<boolean>();
  const controller = new AbortController();
  const result = runConfigWriters(configPath, ['progress-writer'], {
    signal: AbortSignal.any([controller.signal, options.signal]),
    spawnWriter: (path, key) => {
      const child = spawn(process.execPath, ['--import', preloadUrl.href, workerPath, path, key], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          USERPROFILE: root,
          XDG_CONFIG_HOME: join(root, 'xdg'),
          APPDATA: join(root, 'appdata'),
          DO_NOT_TRACK: '1',
        },
      });
      let phase = 'spawned';
      child.on('message', (message: unknown) => {
        if (typeof message === 'string') {
          phase = message;
          return;
        }
        if (
          typeof message !== 'object' ||
          message === null ||
          !('type' in message) ||
          !('url' in message) ||
          typeof message.url !== 'string'
        ) {
          return;
        }
        if (message.type === 'test-module-held' && message.url === initUrl && phase === 'started') {
          entered.resolve(true);
        }
        if (phase !== 'started') return;
        if (message.type === 'test-module-loaded' && !observed.has(message.url)) {
          observed.add(message.url);
          if (options.advanceOnLoad) vi.advanceTimersByTime(20_000);
        }
        if (message.type === 'module-loaded') {
          if (!observed.has(message.url)) premature.push(message.url);
          reported.push(message.url);
        }
      });
      child.once('close', (exitCode, signal) => {
        closes.push({ exitCode, signal });
        entered.resolve(false);
      });
      return child;
    },
  }).then(
    (outcomes) => ({ status: 'passed' as const, outcomes }),
    (error: unknown) => ({ status: 'failed' as const, error }),
  );
  onTestFinished(async () => {
    controller.abort(new Error('preparation fixture finished'));
    await Promise.allSettled([result]);
    rmSync(root, { recursive: true, force: true });
  });
  return { configPath, existing, observed, reported, premature, closes, entered, result };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('config writer cohort lifetime', () => {
  it('does not publish completion before child streams close', async () => {
    vi.useFakeTimers();
    const { children, result } = arrangeWriters(1);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    children[0].emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    children[0].emit('close', 0);
    expect((await result).status).toBe('passed');
  });

  it('settles every acquired child before reporting a spawn error', async () => {
    vi.useFakeTimers();
    const { children, result } = arrangeWriters(2);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    const cause = new Error('writer could not start');
    children[0].pid = undefined;
    children[0].emit('error', cause);
    children[0].emit('close', -2);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(children[1].signals).toEqual(['SIGKILL']);
    children[1].complete();
    expectWriterFailure(await failureOf(result), 'writer-0: phase=spawned', cause);
  });

  it('attributes a writer error to that writer with its last phase and stderr', async () => {
    vi.useFakeTimers();
    const { children, result } = arrangeWriters(2);
    const cause = new Error('channel closed');
    children[1].emit('message', 'started');
    children[1].stderr.write('lock busy');
    children[1].emit('error', cause);
    for (const child of children) child.terminate('SIGKILL');
    expectWriterFailure(await failureOf(result), 'writer-1: phase=started stderr=lock busy', cause);
  });

  it('reports the terminating signal and last phase of a writer killed outside the cohort', async () => {
    vi.useFakeTimers();
    const { children, result } = arrangeWriters(1);
    children[0].emit('message', 'started');
    children[0].terminate('SIGKILL');
    expect(children[0].signals).toEqual([]);
    expect(await result).toMatchObject({
      status: 'passed',
      outcomes: [{ serverKey: 'writer-0', exitCode: null, signal: 'SIGKILL', phase: 'started' }],
    });
  });

  it('accepts a cohort that keeps completing writers past the original total bound', async () => {
    vi.useFakeTimers();
    const { children, result } = arrangeWriters(20);
    for (const child of children) {
      await vi.advanceTimersByTimeAsync(2_000);
      child.complete();
    }
    expect(await result).toMatchObject({ status: 'passed' });
    expect(children.flatMap((child) => child.signals)).toEqual([]);
  });

  it('stops an idle cohort and joins its close events before rejecting', async () => {
    vi.useFakeTimers();
    const { children, result } = arrangeWriters(2);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(children.map((child) => child.signals)).toEqual([['SIGKILL'], ['SIGKILL']]);
    expect(settled).toBe(false);
    for (const child of children) child.complete();
    expect(await result).toMatchObject({
      status: 'failed',
      error: new Error(
        'Config writers made no progress for 30000ms:\nwriter-0: phase=spawned stderr=\nwriter-1: phase=spawned stderr=',
      ),
    });
  });

  it('counts new phases but never repeated messages as progress', async () => {
    vi.useFakeTimers();
    const { children, result } = arrangeWriters(1);
    await vi.advanceTimersByTimeAsync(20_000);
    children[0].emit('message', 'started');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(children[0].signals).toEqual([]);
    children[0].emit('message', 'started');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0].signals).toEqual(['SIGKILL']);
    children[0].complete();
    expect((await result).status).toBe('failed');
  });

  it('joins cancelled children and never signals a child that has exited', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { children, result } = arrangeWriters(2, controller.signal);
    children[0].exitCode = 0;
    children[0].emit('exit', 0);
    controller.abort(new Error('test cancelled'));
    expect(children.map((child) => child.signals)).toEqual([[], ['SIGKILL']]);
    children[0].emit('close', 0);
    children[1].complete();
    expect(await result).toMatchObject({ status: 'failed', error: new Error('test cancelled') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains stderr delivered between exit and close', async () => {
    vi.useFakeTimers();
    const { children, result } = arrangeWriters(1);
    children[0].exitCode = 1;
    children[0].emit('exit', 1, null);
    children[0].stderr.write('write failed');
    children[0].emit('close', 1, null);
    expect(await result).toEqual({
      status: 'passed',
      outcomes: [
        {
          serverKey: 'writer-0',
          exitCode: 1,
          signal: null,
          phase: 'spawned',
          stderr: 'write failed',
        },
      ],
    });
  });

  it('does not start writers after cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const spawnWriter = vi.fn<SpawnWriter>();
    await expect(
      runConfigWriters('/owned/config.json', ['writer'], {
        spawnWriter,
        signal: controller.signal,
      }),
    ).rejects.toThrow('already cancelled');
    expect(spawnWriter).not.toHaveBeenCalled();
  });

  it('joins earlier children if spawning a later writer throws', async () => {
    vi.useFakeTimers();
    const child = new ControlledWriter();
    const cause = new Error('spawn setup failed');
    const spawnWriter: SpawnWriter = (_path, key) => {
      if (key === 'later') throw cause;
      return child;
    };
    const result = runConfigWriters('/owned/config.json', ['first', 'later'], {
      spawnWriter,
    }).catch((error: unknown) => error);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(child.signals).toEqual(['SIGKILL']);
    child.complete();
    expectWriterFailure(await result, 'later: phase=spawned', cause);
  });
});

describe('config writer preparation progress', () => {
  it('does not renew stalled preparation for a repeated completed-work identity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { children, result } = arrangeWriters(1);
    const completed = {
      type: 'module-loaded',
      url: new URL('../../../src/commands/editors.ts', import.meta.url).href,
    };
    children[0].emit('message', 'started');
    children[0].emit('message', completed);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(children[0].signals).toEqual([]);
    children[0].emit('message', { ...completed });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0].signals).toEqual(['SIGKILL']);
    children[0].complete();
    expect((await result).status).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts real preparation work between coarse phases', async ({ signal }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = arrangeRealPreparation({ signal, advanceOnLoad: true });
    expect(vi.getTimerCount()).toBe(1);
    const settled = await fixture.result;
    expect(fixture.observed.size).toBeGreaterThanOrEqual(2);
    expect(settled).toMatchObject({
      status: 'passed',
      outcomes: [{ serverKey: 'progress-writer', exitCode: 0, signal: null, phase: 'written' }],
    });
    expect(fixture.reported.length).toBeGreaterThan(0);
    expect(fixture.premature).toEqual([]);
    expect(fixture.closes).toEqual([{ exitCode: 0, signal: null }]);
    const config: unknown = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
    expect(config).toEqual({
      mcpServers: { existing: fixture.existing, 'progress-writer': expect.any(Object) },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops genuinely stalled real preparation and joins its close before rejecting', async ({
    signal,
  }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = arrangeRealPreparation({ signal, hold: true });
    expect(vi.getTimerCount()).toBe(1);
    const entered = await fixture.entered.promise;
    expect(
      entered,
      entered
        ? undefined
        : inspect({ closes: fixture.closes, result: await fixture.result }, { depth: null }),
    ).toBe(true);
    expect(fixture.observed.size).toBeGreaterThanOrEqual(2);
    expect(fixture.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    const settled = await fixture.result;
    expect(settled).toMatchObject({
      status: 'failed',
      error: expect.objectContaining({
        message: expect.stringContaining('Config writers made no progress for 30000ms:'),
      }),
    });
    expect(fixture.closes).toEqual([{ exitCode: null, signal: 'SIGKILL' }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('joins real writer processes when their test is cancelled', async () => {
  const controller = new AbortController();
  const closed: string[] = [];
  const spawned: ReturnType<typeof spawnConfigWriter>[] = [];
  const root = mkdtempSync(join(tmpdir(), 'config-race-cancel-'));
  const result = runConfigWriters(join(root, 'config.json'), ['first', 'second'], {
    signal: controller.signal,
    spawnWriter: (path, key) => {
      const child = spawnConfigWriter(path, key);
      spawned.push(child);
      child.once('close', () => {
        closed.push(key);
      });
      if (key === 'second') queueMicrotask(() => controller.abort(new Error('cancelled fixture')));
      return child;
    },
  });
  onTestFinished(async () => {
    controller.abort();
    await Promise.allSettled([result]);
    rmSync(root, { recursive: true, force: true });
  });
  await expect(result).rejects.toThrow('cancelled fixture');
  expect(spawned).toHaveLength(2);
  expect(closed.sort()).toEqual(['first', 'second']);
});
