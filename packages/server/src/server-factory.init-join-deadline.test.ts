import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, type TestContext, test } from 'vitest';
import { spawnUnderOwnerLifeline } from '../../../test-support/owner-lifeline.ts';
import {
  assertFactoryResult,
  type FactoryProbeResult,
  READY_LINE,
  RESULT_PREFIX,
  type WatcherTarget,
} from './server-factory.init-join-deadline.test-helper.ts';

const retainedEvidenceRoot = process.env.OK_FACTORY_NATIVE_EVIDENCE_DIR;
const evidenceRoot = retainedEvidenceRoot ?? tmpdir();
const HARNESS = fileURLToPath(
  new URL('./server-factory.init-join-deadline.test-helper.ts', import.meta.url),
);

async function prepareFactoryProbe(ctx: TestContext) {
  mkdirSync(evidenceRoot, { recursive: true });
  const runRoot = realpathSync(mkdtempSync(join(evidenceRoot, 'run-')));
  const root = realpathSync(mkdtempSync(join(runRoot, 'fixture-')));
  const env = { ...process.env, OK_FILE_WATCHER_BACKEND: 'chokidar' };
  delete env.NODE_OPTIONS;
  delete env.OK_VITEST_RUN_EVIDENCE_OWNER;
  delete env.GATE_BASE_SHA;
  delete env.CLAUDE_ENV_FILE;
  const { child, commandResult } = spawnUnderOwnerLifeline(
    process.execPath,
    ['--import', 'tsx', '--conditions=development', HARNESS, root, ctx.task.name],
    { cwd: resolve(import.meta.dirname, '..'), env },
  );
  const ready = Promise.withResolvers<void>();
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('close', (code, signal) => done({ code, signal }));
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.split('\n').includes(READY_LINE)) ready.resolve();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  ctx.onTestFinished(async () => {
    child.stdin.end();
    const completion = await closed;
    const command = await commandResult;
    writeFileSync(join(runRoot, 'child.stdout.log'), stdout);
    writeFileSync(join(runRoot, 'child.stderr.log'), stderr);
    writeFileSync(
      join(runRoot, 'completion.json'),
      JSON.stringify({ completion, command, error: spawnError?.message }),
    );
    rmSync(root, { recursive: true, force: true });
    if (retainedEvidenceRoot === undefined) rmSync(runRoot, { recursive: true, force: true });
  });
  void closed.then(() =>
    ready.reject(new Error(`Child closed before readiness\n${stdout}\n${stderr}`)),
  );
  await ready.promise;
  return async (expireInit: boolean, target: WatcherTarget) => {
    const completion = await closed;
    const command = await commandResult;
    const diagnostics =
      JSON.stringify({ completion, command, error: spawnError?.message }) +
      '\n' +
      stdout +
      '\n' +
      stderr;
    const line = stdout.split('\n').find((entry) => entry.startsWith(RESULT_PREFIX));
    expect(line, diagnostics).toBeDefined();
    if (line === undefined) throw new Error(diagnostics);
    const result = JSON.parse(line.slice(RESULT_PREFIX.length)) as FactoryProbeResult;
    console.log(RESULT_PREFIX + JSON.stringify(result));
    assertFactoryResult(result, join(root, 'project'), expireInit, target);
    expect(spawnError, diagnostics).toBeUndefined();
    expect(command, diagnostics).toEqual({ code: 0, signal: null });
  };
}

const preparedProbes = new WeakMap<TestContext, Awaited<ReturnType<typeof prepareFactoryProbe>>>();

beforeEach(async (ctx) => {
  if (process.platform === 'win32') return;
  preparedProbes.set(ctx, await prepareFactoryProbe(ctx));
});

async function runFactoryProbe(ctx: TestContext, expireInit: boolean, target: WatcherTarget) {
  const probe = preparedProbes.get(ctx);
  if (probe === undefined) throw new Error('Owned factory probe was not prepared');
  await probe(expireInit, target);
}

test('factory control releases real native subscriptions after initialization', async (ctx) => {
  ctx.skip(
    process.platform === 'win32',
    'requires POSIX process-group ownership for the real fixture Git descendants; Node v24.21.0 rejects Windows process-group kills, and this file has no Windows CI lane',
  );
  await runFactoryProbe(ctx, false, 'content');
});

test('factory releases a native acquisition crossing the initialization deadline', async (ctx) => {
  ctx.skip(
    process.platform === 'win32',
    'requires POSIX process-group ownership for the real fixture Git descendants; Node v24.21.0 rejects Windows process-group kills, and this file has no Windows CI lane',
  );
  await runFactoryProbe(ctx, true, 'content');
});

test('factory releases a HEAD acquisition crossing the initialization deadline', async (ctx) => {
  ctx.skip(
    process.platform === 'win32',
    'requires POSIX process-group ownership for the real fixture Git descendants; Node v24.21.0 rejects Windows process-group kills, and this file has no Windows CI lane',
  );
  await runFactoryProbe(ctx, true, 'head');
});
