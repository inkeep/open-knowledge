import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type TestContext, test } from 'vitest';

const OWNER = fileURLToPath(new URL('./shadow-fixture-owner.test-helper.mjs', import.meta.url));
const SUBJECT = fileURLToPath(new URL('./shadow-fixture-subject.test-helper.mjs', import.meta.url));
const CALLER = fileURLToPath(new URL('./shadow-fixture-caller.test-helper.mjs', import.meta.url));
const VITEST = fileURLToPath(new URL('vitest.mjs', import.meta.resolve('vitest/package.json')));

function createOwner(context: TestContext, args = [SUBJECT], configuration = {}, caller = false) {
  const evidenceRoot = process.env.OK_SHADOW_SAFETY_EVIDENCE_DIR ?? tmpdir();
  mkdirSync(evidenceRoot, { recursive: true });
  const resultDir = mkdtempSync(join(evidenceRoot, 'ok-shadow-safety-result-'));
  const owner = fork(caller ? CALLER : OWNER, [], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  writeFileSync(join(resultDir, 'sibling.txt'), 'Outside the owned scratch root.\n');
  appendFileSync(
    join(resultDir, 'parent-events.jsonl'),
    `${JSON.stringify({ type: 'spawn', pid: owner.pid, at: Date.now() })}\n`,
  );
  owner.on('exit', (code, signal) =>
    appendFileSync(
      join(resultDir, 'parent-events.jsonl'),
      `${JSON.stringify({ type: 'exit', code, signal, at: Date.now() })}\n`,
    ),
  );
  owner.on('close', (code, signal) =>
    appendFileSync(
      join(resultDir, 'parent-events.jsonl'),
      `${JSON.stringify({ type: 'close', code, signal, at: Date.now() })}\n`,
    ),
  );
  const exited = new Promise<void>((resolve) => owner.once('exit', () => resolve()));
  const stdoutClosed = new Promise<void>((resolve) => owner.stdout?.once('close', () => resolve()));
  const stderrClosed = new Promise<void>((resolve) => owner.stderr?.once('close', () => resolve()));
  const disconnected = new Promise<void>((resolve) => owner.once('disconnect', () => resolve()));
  const closed = Promise.all([exited, stdoutClosed, stderrClosed, disconnected]).then(() => {
    appendFileSync(
      join(resultDir, 'parent-events.jsonl'),
      `${JSON.stringify({ type: 'exit-and-streams-closed', at: Date.now() })}\n`,
    );
  });
  owner.stderr?.on('data', (data) => appendFileSync(join(resultDir, 'owner.stderr'), data));
  owner.stdout?.on('data', (data) => appendFileSync(join(resultDir, 'owner.stdout'), data));
  context.onTestFinished(async () => {
    if (owner.connected) owner.send({ type: 'release' });
    await closed;
    if (!process.env.OK_SHADOW_SAFETY_EVIDENCE_DIR)
      rmSync(resultDir, { recursive: true, force: true });
  });
  owner.send({
    type: 'start',
    config: {
      resultDir,
      args,
      cwd: process.cwd(),
      maxLifetimeMs: 20_000,
      env: { OK_SHADOW_SUBJECT_RESULT: join(resultDir, 'result.json') },
      ...configuration,
    },
  });
  return { owner, closed, resultDir };
}

function events(resultDir: string): { type: string; args?: string[]; id: string }[] {
  const path = join(resultDir, 'ownership.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function pendingFence(resultDir: string): string | undefined {
  const startedPath = join(resultDir, 'started.json');
  if (!existsSync(startedPath)) return undefined;
  const { workDir } = JSON.parse(readFileSync(startedPath, 'utf8'));
  if (!existsSync(workDir)) return undefined;
  for (const entry of readdirSync(workDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('ok-shadow-settle-fence-')) continue;
    const ok = join(workDir, entry.name, '.ok');
    if (!existsSync(ok)) continue;
    const name = readdirSync(ok).find((file) => file.startsWith('watcher-settle-fence-'));
    if (name) return join(ok, name);
  }
  return undefined;
}

function waitForOwnerEvent(owner: ReturnType<typeof fork>, resultDir: string, type: string) {
  const find = () => events(resultDir).find((row) => row.type === type);
  const existing = find();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      owner.off('message', onMessage);
      owner.off('exit', onExit);
      owner.off('disconnect', onDisconnect);
      callback();
    };
    const onMessage = (message: { type?: string; row?: { type?: string } }) => {
      if (message.type === 'event' && message.row?.type === type)
        finish(() => resolve(message.row));
    };
    const onExit = (code: number | null, signal: string | null) =>
      finish(() =>
        reject(
          new Error(
            `owner exited before ${type}: code=${code ?? 'null'} signal=${signal ?? 'null'} observed=${
              [...new Set(events(resultDir).map((row) => row.type))].join(',') || 'none'
            }`,
          ),
        ),
      );
    const onDisconnect = () =>
      finish(() =>
        reject(
          new Error(
            `owner disconnected before ${type}: observed=${
              [...new Set(events(resultDir).map((row) => row.type))].join(',') || 'none'
            }`,
          ),
        ),
      );
    owner.on('message', onMessage);
    owner.once('exit', onExit);
    owner.once('disconnect', onDisconnect);
    const observed = find();
    if (observed) finish(() => resolve(observed));
  });
}

test('native Git acquisitions preserve synchronous results under a live owner', async (context) => {
  const { resultDir, closed } = createOwner(context);
  await expect
    .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 15_000 })
    .toBe(true);
  await closed;
  const result = JSON.parse(readFileSync(join(resultDir, 'result.json'), 'utf8'));
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(result.output).toMatch(/^git version 2\./);
  expect(receipt.runnerExit).toEqual({ code: 0, signal: null });
  expect(receipt.children.filter((child: { id: string }) => child.id !== 'runner')).toHaveLength(1);
  expect(receipt.children.every((child: { close: unknown }) => child.close)).toBe(true);
  expect(receipt.normalResidue).toEqual([]);
  expect(receipt.workDirAbsent).toBe(true);
});

test('native Git acquisitions and scratch are reclaimed after caller loss', async (context) => {
  const { resultDir, closed, owner } = createOwner(context, [SUBJECT, 'async-hold'], {
    maxLifetimeMs: 6_000,
  });
  await expect
    .poll(
      () => events(resultDir).some((row) => row.type === 'spawn' && row.args?.includes('--stdin')),
      { timeout: 3_000 },
    )
    .toBe(true);
  const started = JSON.parse(readFileSync(join(resultDir, 'started.json'), 'utf8'));
  expect(existsSync(started.workDir)).toBe(true);
  owner.disconnect();
  await expect
    .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 1_000 })
    .toBe(true);
  await closed;
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(receipt.reason).toBe('caller disconnected');
  expect(receipt.before.length).toBeGreaterThan(0);
  expect(receipt.children.every((child: { close: unknown }) => child.close)).toBe(true);
  expect(receipt.workDirAbsent).toBe(true);
});

test('native Git transport preserves byte streams and native failures', async (context) => {
  const { resultDir, closed } = createOwner(context, [SUBJECT, 'conformance'], {
    maxLifetimeMs: 8_000,
  });
  await expect
    .poll(() => existsSync(join(resultDir, 'result.json')), { timeout: 6_000 })
    .toBe(true);
  await closed;
  const result = JSON.parse(readFileSync(join(resultDir, 'result.json'), 'utf8'));
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  const input = Buffer.from([65, 0, 66, 10, 255]);
  const expectedBlob = createHash('sha1')
    .update(Buffer.from(`blob ${input.length}\0`))
    .update(input)
    .digest('hex');
  expect(Buffer.from(result.listed, 'base64')).toEqual(Buffer.from('line\nname.md\0note.md\0'));
  expect(result.output).toBe(`${expectedBlob}\n`);
  expect(result.closed).toEqual({ code: 0, signal: null });
  const missing = receipt.events.find(
    (row: { type: string; args?: string[] }) =>
      row.type === 'spawn' && row.args?.includes('refs/heads/missing'),
  );
  expect(missing).toBeDefined();
  const nativeFailure = receipt.children.find(
    (child: { id: string }) => child.id === missing.id,
  ).close;
  expect(result.rejected.status).toBe(nativeFailure.code);
  expect(result.rejected.signal).toBe(nativeFailure.signal);
  expect(result.rejected.stderr.length).toBeGreaterThan(0);
  expect(receipt.runnerExit).toEqual({ code: 0, signal: null });
  expect(receipt.normalResidue).toEqual([]);
  expect(receipt.workDirAbsent).toBe(true);
});

test('native Git transport preserves synchronous timeouts and asynchronous signals', async (context) => {
  const { resultDir, closed } = createOwner(context, [SUBJECT, 'termination'], {
    holdSyncInput: true,
  });
  await expect
    .poll(() => existsSync(join(resultDir, 'result.json')), { timeout: 5_000 })
    .toBe(true);
  await closed;
  const result = JSON.parse(readFileSync(join(resultDir, 'result.json'), 'utf8'));
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(result.timeout).toEqual({ code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' });
  expect(result.signaled).toBe(true);
  expect(result.closed).toEqual({ code: null, signal: 'SIGTERM' });
  const git = receipt.children.filter((child: { id: string }) => child.id !== 'runner');
  expect(git).toHaveLength(2);
  expect(
    git.every((child: { close: { signal: string } }) => child.close.signal === 'SIGTERM'),
  ).toBe(true);
  expect(receipt.normalResidue).toEqual([]);
  expect(receipt.workDirAbsent).toBe(true);
});

test('synchronous native Git is reclaimed after abrupt caller loss', async (context) => {
  const { resultDir, closed, owner } = createOwner(
    context,
    [SUBJECT, 'sync-hold'],
    { holdSyncInput: true, maxLifetimeMs: 6_000 },
    true,
  );
  await expect
    .poll(
      () => events(resultDir).some((row) => row.type === 'spawn' && row.args?.includes('--stdin')),
      { timeout: 3_000 },
    )
    .toBe(true);
  expect(owner.exitCode).toBeNull();
  const lostAt = Date.now();
  owner.kill('SIGKILL');
  await expect
    .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 3_000 })
    .toBe(true);
  await closed;
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(owner.signalCode).toBe('SIGKILL');
  expect(receipt.reason).toBe('caller disconnected');
  expect(receipt.finishedAt - lostAt).toBeLessThan(3_000);
  expect(receipt.before.length).toBeGreaterThan(1);
  expect(receipt.children.every((child: { close: unknown }) => child.close)).toBe(true);
  expect(receipt.workDirAbsent).toBe(true);
  expect(readFileSync(join(resultDir, 'sibling.txt'), 'utf8')).toBe(
    'Outside the owned scratch root.\n',
  );
});

test('the lifetime oracle rejects disabled owner-loss cleanup before bounded fallback', async (context) => {
  const { resultDir, closed, owner } = createOwner(
    context,
    [SUBJECT, 'async-hold'],
    { autoCleanup: false, maxLifetimeMs: 1_500 },
    true,
  );
  await expect
    .poll(
      () => events(resultDir).some((row) => row.type === 'spawn' && row.args?.includes('--stdin')),
      { timeout: 1_000 },
    )
    .toBe(true);
  const started = JSON.parse(readFileSync(join(resultDir, 'started.json'), 'utf8'));
  expect(existsSync(started.workDir)).toBe(true);
  owner.kill('SIGKILL');
  let rejection: unknown;
  try {
    await expect
      .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 300 })
      .toBe(true);
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect(existsSync(started.workDir)).toBe(true);
  const activeBeforeFallback = events(resultDir);
  const git = activeBeforeFallback.find(
    (row) => row.type === 'spawn' && row.args?.includes('--stdin'),
  );
  expect(git).toBeDefined();
  expect(activeBeforeFallback.some((row) => row.type === 'close' && row.id === git?.id)).toBe(
    false,
  );
  writeFileSync(
    join(resultDir, 'negative-oracle.json'),
    JSON.stringify({
      rejection: String(rejection),
      scratchPresent: true,
      nativeGitCloseObserved: false,
    }),
  );
  await expect
    .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 3_000 })
    .toBe(true);
  await closed;
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(receipt.reason).toBe('maximum lifetime reached');
  expect(receipt.children.every((child: { close: unknown }) => child.close)).toBe(true);
  expect(receipt.workDirAbsent).toBe(true);
  expect(readFileSync(join(resultDir, 'sibling.txt'), 'utf8')).toBe(
    'Outside the owned scratch root.\n',
  );
});

test('the frozen shadow fixture is reclaimed after abrupt test-worker loss', async (context) => {
  const { resultDir, closed, owner } = createOwner(
    context,
    [
      VITEST,
      'run',
      'src/shadow-settle-fence.test.ts',
      '--pool=threads',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=verbose',
    ],
    { holdCapture: true, readinessGate: true },
  );
  await waitForOwnerEvent(owner, resultDir, 'worker-start');
  owner.send({ type: 'release-readiness' });
  await waitForOwnerEvent(owner, resultDir, 'capture-held');
  const fence = pendingFence(resultDir);
  expect(fence).toBeDefined();
  if (!fence) throw new Error('pending fence disappeared before the owner-loss observation');
  expect(readFileSync(fence).length).toBe(0);
  const before = events(resultDir);
  expect(before.some((row) => row.type === 'worker-start')).toBe(true);
  expect(before.some((row) => row.type === 'spawn' && row.args?.includes('write-tree'))).toBe(true);
  owner.send({ type: 'lose-worker' });
  await expect
    .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 5_000 })
    .toBe(true);
  await closed;
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(receipt.reason).toBe('test worker lost');
  expect(receipt.trigger, `runnerExit=${JSON.stringify(receipt.runnerExit)}`).toBe(
    'test worker lost',
  );
  expect(
    receipt.runtimes.some(
      (row: { terminateRequested?: number }) => row.terminateRequested !== undefined,
    ),
  ).toBe(true);
  expect(
    receipt.runtimes.some(
      (row: { workerExit?: number; code: number }) =>
        row.workerExit !== undefined && row.code !== 0,
    ),
  ).toBe(true);
  expect(receipt.children.every((child: { close: unknown }) => child.close)).toBe(true);
  expect(receipt.workDirAbsent).toBe(true);
  expect(existsSync(fence)).toBe(false);
});

test('runner close after a worker-loss request is attributed to the requested worker loss', async (context) => {
  const { resultDir, closed, owner } = createOwner(
    context,
    [
      VITEST,
      'run',
      'src/shadow-settle-fence.test.ts',
      '--pool=threads',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=verbose',
    ],
    { holdCapture: true, readinessGate: true, dropWorkerLossRequest: true },
  );
  await waitForOwnerEvent(owner, resultDir, 'worker-start');
  owner.send({ type: 'release-readiness' });
  await waitForOwnerEvent(owner, resultDir, 'capture-held');
  const fence = pendingFence(resultDir);
  expect(fence).toBeDefined();
  if (!fence) throw new Error('pending fence disappeared before the runner-loss observation');
  owner.send({ type: 'lose-worker' });
  await expect
    .poll(
      () =>
        events(resultDir).some(
          (row) => row.type === 'worker-loss-requested' && row.delivered === false,
        ),
      { timeout: 3_000 },
    )
    .toBe(true);
  owner.send({ type: 'lose-runner' });
  await expect
    .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 5_000 })
    .toBe(true);
  await closed;
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(receipt.reason).toBe('test worker lost');
  expect(receipt.trigger).toBe('runner closed');
  expect(receipt.runnerExit).toEqual({ code: null, signal: 'SIGKILL' });
  expect(
    receipt.events.some(
      (row: { type: string; delivered?: boolean }) =>
        row.type === 'worker-loss-requested' && row.delivered === false,
    ),
  ).toBe(true);
  expect(
    receipt.runtimes.some(
      (row: { threadId?: number; execArgv?: string[] }) =>
        row.execArgv !== undefined && row.threadId !== undefined && row.threadId !== 0,
    ),
  ).toBe(true);
  expect(
    receipt.runtimes.some((row: { workerExit?: number }) => row.workerExit !== undefined),
  ).toBe(false);
  expect(
    receipt.runtimes.some(
      (row: { terminateRequested?: number }) => row.terminateRequested !== undefined,
    ),
  ).toBe(false);
  expect(receipt.children.every((child: { close: unknown }) => child.close)).toBe(true);
  expect(receipt.workDirAbsent).toBe(true);
  expect(existsSync(fence)).toBe(false);
});

test('the frozen shadow fixture and live native Git are reclaimed after abrupt runner loss', async (context) => {
  const { resultDir, closed, owner } = createOwner(
    context,
    [
      VITEST,
      'run',
      'src/shadow-settle-fence.test.ts',
      '--pool=threads',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=verbose',
    ],
    { holdCapture: true, readinessGate: true },
  );
  await waitForOwnerEvent(owner, resultDir, 'worker-start');
  owner.send({ type: 'release-readiness' });
  await waitForOwnerEvent(owner, resultDir, 'capture-held');
  const fence = pendingFence(resultDir);
  expect(fence).toBeDefined();
  if (!fence) throw new Error('pending fence disappeared before the runner-loss observation');
  expect(readFileSync(fence).length).toBe(0);
  owner.send({ type: 'hold-git' });
  await expect
    .poll(
      () => events(resultDir).some((row) => row.type === 'spawn' && row.id === 'held-native-git'),
      { timeout: 3_000 },
    )
    .toBe(true);
  expect(
    events(resultDir).some((row) => row.type === 'close' && row.id === 'held-native-git'),
  ).toBe(false);
  owner.send({ type: 'lose-runner' });
  await expect
    .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 5_000 })
    .toBe(true);
  await closed;
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(receipt.runnerExit).toEqual({ code: null, signal: 'SIGKILL' });
  expect(receipt.before).toContain('held-native-git');
  expect(
    receipt.children.find((child: { id: string }) => child.id === 'held-native-git').close.signal,
  ).toBe('SIGTERM');
  expect(receipt.children.every((child: { close: unknown }) => child.close)).toBe(true);
  expect(receipt.workDirAbsent).toBe(true);
  expect(existsSync(fence)).toBe(false);
  expect(readFileSync(join(resultDir, 'sibling.txt'), 'utf8')).toBe(
    'Outside the owned scratch root.\n',
  );
});

test('caller loss during acquisition leaves no untethered fixture', async (context) => {
  const { resultDir, closed, owner } = createOwner(
    context,
    [SUBJECT, 'async-hold'],
    { maxLifetimeMs: 6_000 },
    true,
  );
  await expect
    .poll(() => existsSync(join(resultDir, 'started.json')), { timeout: 3_000, interval: 10 })
    .toBe(true);
  const started = JSON.parse(readFileSync(join(resultDir, 'started.json'), 'utf8'));
  expect(existsSync(started.workDir)).toBe(true);
  owner.kill('SIGKILL');
  await expect
    .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 20_000 })
    .toBe(true);
  await closed;
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(owner.signalCode).toBe('SIGKILL');
  expect(receipt.trigger).toBe('caller disconnected');
  expect(receipt.children.some((child: { id: string }) => child.id === 'runner')).toBe(true);
  expect(receipt.children.every((child: { close: unknown }) => child.close)).toBe(true);
  expect(receipt.workDirAbsent).toBe(true);
  expect(readFileSync(join(resultDir, 'sibling.txt'), 'utf8')).toBe(
    'Outside the owned scratch root.\n',
  );
});

test('an unsupported node acquisition is rejected and existing resources are reclaimed', async (context) => {
  const { resultDir, closed } = createOwner(context, [SUBJECT, 'unsupported-node']);
  await expect
    .poll(() => existsSync(join(resultDir, 'cleanup.json')), { timeout: 5_000 })
    .toBe(true);
  await closed;
  const receipt = JSON.parse(readFileSync(join(resultDir, 'cleanup.json'), 'utf8'));
  expect(
    receipt.events.some(
      (row: { type: string; args?: string[] }) =>
        row.type === 'spawn' && row.args?.includes('--stdin'),
    ),
  ).toBe(true);
  expect(receipt.events.some((row: { type: string }) => row.type === 'scope-gap')).toBe(true);
  expect(receipt.reason).toBe('owner error');
  expect(receipt.children.some((child: { id: string }) => child.id !== 'runner')).toBe(true);
  expect(receipt.children.every((child: { close: unknown }) => child.close)).toBe(true);
  expect(
    receipt.events.filter(
      (row: { type: string; executable?: string }) =>
        row.type === 'spawn' && row.executable === process.execPath,
    ),
  ).toHaveLength(1);
  expect(receipt.workDirAbsent).toBe(true);
});
