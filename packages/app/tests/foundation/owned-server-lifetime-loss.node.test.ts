import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { launchOwnedWorkerServer } from '../stress/_helpers/reuse/owned-dev-server.ts';

const harness = vi.hoisted(() => ({
  proc: undefined as (import('node:events').EventEmitter & Record<string, unknown>) | undefined,
  readiness: undefined as
    | { promise: Promise<unknown>; resolve: (value: unknown) => void }
    | undefined,
  releases: [] as string[],
}));

vi.mock('../stress/_helpers/fixtures.ts', async (importOriginal) => {
  const fixtures = await importOriginal<typeof import('../stress/_helpers/fixtures.ts')>();
  return {
    ...fixtures,
    spawnWorkerDevServer: () => harness.proc,
    waitForServerReady: () => harness.readiness?.promise,
  };
});

vi.mock('../stress/_helpers/worker-server-lifetime.ts', async (importOriginal) => {
  const lifetime =
    await importOriginal<typeof import('../stress/_helpers/worker-server-lifetime.ts')>();
  return {
    ...lifetime,
    stopWorkerServer: async () => {
      harness.releases.push('stop');
    },
    completeWorkerServerRelease: async () => {
      harness.releases.push('release');
    },
  };
});

const LIFETIME_LOSS =
  'worker server lifetime closed without completed release (code=1, signal=null)';
const LABEL = 'lifetime-loss-s0';
const savedTmpdir = process.env.TMPDIR;
const scratchDirs: string[] = [];

afterEach(() => {
  harness.proc = undefined;
  harness.readiness = undefined;
  harness.releases.splice(0);
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchTmpdir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-owned-lifetime-scratch-')));
  scratchDirs.push(root);
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  process.env.TMPDIR = tmp;
  return tmp;
}

describe('an owned server whose lifetime is lost while it launches', () => {
  test('a lifetime lost before the server answers fails the launch with that loss and releases the server, even when the server answers afterwards', async () => {
    const tmp = scratchTmpdir();
    harness.proc = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    let resolveReadiness!: (value: unknown) => void;
    harness.readiness = {
      promise: new Promise((resolve) => {
        resolveReadiness = resolve;
      }),
      resolve: (value) => resolveReadiness(value),
    };

    const outcome = launchOwnedWorkerServer({
      label: LABEL,
      workerServerEnv: {},
      serving: { kind: 'dev-server' },
    }).then(
      () => 'granted',
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(harness.proc?.listenerCount('error')).toBeGreaterThan(0));
    harness.proc.emit('error', new Error(LIFETIME_LOSS));
    harness.readiness.resolve({ baseURL: 'http://127.0.0.1:5999', port: 5999 });

    const failure = await outcome;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message.split('\n')[0]).toBe(LIFETIME_LOSS);
    expect(harness.releases).toEqual(['stop', 'release']);
    expect(readdirSync(tmp)).toEqual([]);
  });
});
