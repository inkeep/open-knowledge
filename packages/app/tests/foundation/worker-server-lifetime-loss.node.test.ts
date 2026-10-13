import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  closeServerLog,
  createViteStartupRequest,
  openServerLog,
} from '../stress/_helpers/server-process.ts';
import {
  acquireWorkerServer,
  completeWorkerServerRelease,
  stopWorkerServer,
} from '../stress/_helpers/worker-server-lifetime.ts';

const LIFETIME_LOSS =
  'worker server lifetime closed without completed release (code=1, signal=null)';
const RELEASE_LOSS = 'worker server lifetime closed before release completed';
const REAP_MS = 10_000;
const saved = { TMPDIR: process.env.TMPDIR, NODE_OPTIONS: process.env.NODE_OPTIONS };
const scratchDirs: string[] = [];

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lostOwnerLaunch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lifetime-loss-')));
  scratchDirs.push(root);
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const contentDir = join(root, 'content');
  mkdirSync(contentDir);
  const viteCacheDir = join(root, 'vite-cache');
  mkdirSync(viteCacheDir);
  process.env.TMPDIR = tmp;
  const request = createViteStartupRequest('127.0.0.1');
  const serverLog = openServerLog('lifetime-loss');
  process.env.NODE_OPTIONS = `--require=${join(root, 'no-such-preload.cjs')}`;
  const proc = acquireWorkerServer(
    request,
    {},
    contentDir,
    viteCacheDir,
    serverLog,
    { kind: 'dev-server' },
    REAP_MS,
  );
  const cleanup = () => {
    closeServerLog(serverLog);
    request.dispose();
    rmSync(serverLog.path, { force: true });
  };
  return { proc, cleanup, tmp };
}

describe('a worker server lifetime whose owner is lost, with no caller listening for errors', () => {
  test('the loss reaches the release that follows, and never surfaces as an unhandled error', async () => {
    const { proc, cleanup, tmp } = lostOwnerLaunch();

    const release = await completeWorkerServerRelease(proc, cleanup).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(release).toBeInstanceOf(Error);
    expect((release as Error).message).toBe(RELEASE_LOSS);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test('a stop after the loss reports the same loss instead of waiting out its bound', async () => {
    const { proc, cleanup } = lostOwnerLaunch();
    const release = await completeWorkerServerRelease(proc, cleanup).then(
      () => undefined,
      (error: unknown) => error,
    );

    const stop = await stopWorkerServer(proc, REAP_MS).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((release as Error).message).toBe(RELEASE_LOSS);
    expect(stop).toBeInstanceOf(Error);
    expect((stop as Error).message).toBe(LIFETIME_LOSS);
  });
});
