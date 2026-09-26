import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { logsCurrentPath } from './telemetry-file-sink.ts';

const PRIMITIVE = new URL('./polled-path-watcher.ts', import.meta.url).href;
const LOGGER = new URL('./logger.ts', import.meta.url).href;

const WATCHER_WITH_A_THROWING_ON_ERROR = `
const [primitive, logger, dir, listFailure] = process.argv.slice(1);
const { startPolledPathWatcher } = await import(primitive);
const { loggerFactory } = await import(logger);
const { writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
loggerFactory.configure({ pinoConfig: { fileSink: { projectDir: dir, maxBytes: 1_000_000 } } });
const watched = join(dir, 'watched.txt');
const unstatable = join(dir, 'x'.repeat(300));
writeFileSync(watched, 'before');
const listPathsFailure = () => {
  const err = new Error('listPaths failed');
  if (listFailure === 'unserializable') {
    Object.defineProperty(err, 'detail', {
      enumerable: true,
      get() {
        throw new Error('detail cannot be read');
      },
    });
  }
  return err;
};
let phase = 'starting';
const say = (line) => process.stdout.write(line + '\\n');
const stop = await startPolledPathWatcher({
  listPaths: async () => {
    if (phase === 'list-failing') throw listPathsFailure();
    return phase === 'path-failing' ? [watched, unstatable] : [watched];
  },
  onEvent: (event, path) => {
    if (phase !== 'editing' || event !== 'change' || path !== watched) return;
    say('edit-delivered');
    void stop().then(() => loggerFactory.flushAllFileSinks());
  },
  onError: (err, path) => {
    if (phase === 'path-failing' && path === unstatable) {
      say('path-error-reported ' + err.code);
      phase = 'list-failing';
    } else if (phase === 'list-failing' && path === undefined) {
      say('list-error-reported ' + err.message);
      phase = 'editing';
      writeFileSync(watched, 'after, and longer');
    }
    throw new Error('onError threw');
  },
});
phase = 'path-failing';
say('started');
`;

const WATCHER_OF_A_FILE_STAMPED_AHEAD = `
const [primitive, dir, stampsAhead] = process.argv.slice(1);
const fs = await import('node:fs');
const { syncBuiltinESMExports } = await import('node:module');
const { join } = await import('node:path');
const DAY_MS = 86_400_000;
const DAY_NS = 86_400_000_000_000n;
const NS_PER_S = 1_000_000_000n;
const SAMPLES = 30;
const watched = join(dir, 'watched.txt');
let reads = 0;
const readFile = fs.promises.readFile;
fs.promises.readFile = function (path, ...rest) {
  if (String(path) === watched) reads += 1;
  return Reflect.apply(readFile, this, [path, ...rest]);
};
if (stampsAhead === 'mtime and ctime') {
  const stat = fs.promises.stat;
  fs.promises.stat = async function (path, ...rest) {
    const stats = await Reflect.apply(stat, this, [path, ...rest]);
    if (String(path) === watched && typeof stats.ctimeNs === 'bigint') {
      Object.assign(stats, { mtimeNs: stats.mtimeNs + DAY_NS, ctimeNs: stats.ctimeNs + DAY_NS });
    }
    return stats;
  };
}
syncBuiltinESMExports();
const { startPolledPathWatcher } = await import(primitive);
fs.writeFileSync(watched, 'before');
if (stampsAhead === 'mtime') {
  const ahead = new Date(Date.now() + DAY_MS);
  fs.utimesSync(watched, ahead, ahead);
}
const stamped = await fs.promises.stat(watched, { bigint: true });
const nowNs = BigInt(Date.now()) * 1_000_000n;
const readsAtSample = [];
const stop = await startPolledPathWatcher({
  listPaths: async () => {
    readsAtSample.push(reads);
    if (readsAtSample.length === SAMPLES + 1) fs.writeFileSync(watched, 'BEFORE');
    return [watched];
  },
  onEvent: (event, path) => {
    if (event !== 'change' || path !== watched || readsAtSample.length <= SAMPLES) return;
    process.stdout.write(
      JSON.stringify({
        mtimeAheadOfNowS: Number((stamped.mtimeNs - nowNs) / NS_PER_S),
        mtimeAheadOfCtimeS: Number((stamped.mtimeNs - stamped.ctimeNs) / NS_PER_S),
        readsInEarlySamples: readsAtSample[6] - readsAtSample[1],
        readsInLateSamples: readsAtSample[SAMPLES] - readsAtSample[SAMPLES - 5],
      }) + '\\n',
    );
    void stop();
  },
  onError: (err) => {
    process.stderr.write(String(err) + '\\n');
  },
});
`;

type ListFailure = 'serializable' | 'unserializable';

type StampsAhead = 'mtime' | 'mtime and ctime';

interface StampedAheadReport {
  mtimeAheadOfNowS: number;
  mtimeAheadOfCtimeS: number;
  readsInEarlySamples: number;
  readsInLateSamples: number;
}

interface ChildOutcome {
  code: number | null;
  stdout: string[];
  stderr: string;
}

interface LoggedError {
  code?: string;
  message?: string;
}

interface PrimitiveLogRecord {
  name?: string;
  path?: string;
  err?: LoggedError;
  error?: LoggedError;
}

function runChild(script: string, args: readonly string[]): Promise<ChildOutcome> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--conditions=@inkeep/source',
      '--input-type=module',
      '--eval',
      script,
      ...args,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OK_CONSOLE_LEVEL: 'silent', OK_FILE_LEVEL: 'trace' },
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolveOutcome) => {
    child.once('close', (code) => {
      resolveOutcome({ code, stdout: stdout.split('\n').filter(Boolean), stderr });
    });
  });
}

function runWatcherWithAThrowingOnError(
  dir: string,
  listFailure: ListFailure,
): Promise<ChildOutcome> {
  return runChild(WATCHER_WITH_A_THROWING_ON_ERROR, [PRIMITIVE, LOGGER, dir, listFailure]);
}

async function watchAFileStampedAhead(
  dir: string,
  stampsAhead: StampsAhead,
): Promise<StampedAheadReport> {
  const outcome = await runChild(WATCHER_OF_A_FILE_STAMPED_AHEAD, [PRIMITIVE, dir, stampsAhead]);
  expect(outcome.code, `the watcher process exit code; stderr: ${outcome.stderr}`).toBe(0);
  expect(
    outcome.stdout,
    `the watcher process must report once, after the same-size rewrite is delivered; stderr: ${outcome.stderr}`,
  ).toHaveLength(1);
  return JSON.parse(outcome.stdout[0] ?? 'null');
}

function primitiveLogRecords(dir: string): PrimitiveLogRecord[] {
  const logPath = logsCurrentPath(dir);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line): PrimitiveLogRecord => JSON.parse(line))
    .filter((record) => record.name === 'polled-path-watcher');
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ok-polled-watcher-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('startPolledPathWatcher when its onError callback throws', () => {
  test.each<[string, ListFailure]>([
    ['a failing path and a failing listPaths', 'serializable'],
    ['a failing path and a failing listPaths whose error cannot be serialized', 'unserializable'],
  ])('keeps the process alive and keeps polling through %s', async (_, listFailure) => {
    const outcome = await runWatcherWithAThrowingOnError(dir, listFailure);

    expect(
      outcome.stdout,
      `the watcher process must report both errors and then deliver the later edit; stderr: ${outcome.stderr}`,
    ).toEqual([
      'started',
      'path-error-reported ENAMETOOLONG',
      'list-error-reported listPaths failed',
      'edit-delivered',
    ]);
    expect(outcome.code, `the watcher process exit code; stderr: ${outcome.stderr}`).toBe(0);
  });

  test('logs each error it was reporting together with the exception its onError threw', async () => {
    const outcome = await runWatcherWithAThrowingOnError(dir, 'serializable');
    expect(outcome.code, `the watcher process exit code; stderr: ${outcome.stderr}`).toBe(0);

    expect(
      primitiveLogRecords(dir).map(({ err, error, path }) => ({
        reported: err?.code ?? err?.message,
        path,
        thrown: error?.message,
      })),
      `the records the primitive wrote to ${logsCurrentPath(dir)}`,
    ).toEqual([
      { reported: 'ENAMETOOLONG', path: join(dir, 'x'.repeat(300)), thrown: 'onError threw' },
      { reported: 'listPaths failed', path: undefined, thrown: 'onError threw' },
    ]);
  });
});

describe('startPolledPathWatcher on a file whose timestamps lie ahead of the host clock', () => {
  test('stops reading the file once its change time is past the timestamp bound when only its modification time was set ahead, and still reports a later same-size rewrite', async () => {
    const report = await watchAFileStampedAhead(dir, 'mtime');

    expect(
      report.mtimeAheadOfNowS,
      'seconds the modification time lies ahead of the host clock',
    ).toBeGreaterThan(3);
    expect(
      report.mtimeAheadOfCtimeS,
      'seconds the modification time lies ahead of the change time',
    ).toBeGreaterThan(3);
    expect(
      report.readsInEarlySamples,
      "reads of the file in samples 1-5, inside the change time's bound",
    ).toBeGreaterThan(0);
    expect(
      report.readsInLateSamples,
      "reads of the file in samples 25-29, past the change time's bound",
    ).toBe(0);
  });

  test('keeps reading the file while its change time lies ahead as well (both timestamps modelled a day ahead at the stat seam)', async () => {
    const report = await watchAFileStampedAhead(dir, 'mtime and ctime');

    expect(
      report.mtimeAheadOfNowS,
      'seconds the modification time lies ahead of the host clock',
    ).toBeGreaterThan(3);
    expect(report.readsInLateSamples, 'reads of the file in samples 25-29').toBeGreaterThan(0);
  });
});
