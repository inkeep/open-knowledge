import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, onTestFinished, test } from 'vitest';
import { holdServerLogTail, SERVER_LOG_TAIL_LINES } from '../stress/_helpers/fixtures.ts';
import { productionShellLockPath } from '../stress/_helpers/production-shell-readiness.ts';
import {
  PRODUCTION_SHELL_ENV,
  type ProductionShellLaunch,
} from '../stress/_helpers/production-shell-server.ts';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/seed-key.ts';
import {
  closeServerLog,
  createViteStartupRequest,
  getFreePort,
  openServerLog,
} from '../stress/_helpers/server-process.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import type { WorkerServerLaunch } from '../stress/_helpers/worker-server-command.ts';

const TEST_TIMEOUT_MS = 30_000;
const REAP_MS = 5_000;
const POLL_MS = 25;
const CLI_SOURCE_ENTRY = join(APP_PACKAGE_ROOT, '..', 'cli', 'src', 'cli.ts');
const LIFETIME = join(
  APP_PACKAGE_ROOT,
  'tests',
  'stress',
  '_helpers',
  'worker-server-lifetime.cjs',
);
const OWNER_LOSS_RECORD =
  /\[worker-server-lifetime\] owner-loss trigger=(\S+) ownerPid=(\d+) ownerAlive=(true|false|null) serverPid=(\d+|null) elapsedMs=(\d+) readiness=(\S+)\n/;

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Lock = Record<string, unknown>;

interface ProductionShellLifetime {
  readonly child: ChildProcess;
  readonly boundLock: Lock;
  readonly port: number;
  readonly messages: readonly unknown[];
  readonly serverLog: () => string;
  readonly serverLogPath: string;
  readonly setupFailureReport: () => string;
  readonly exit: () => Exit | undefined;
  readonly until: <T>(what: string, attempt: () => T | undefined) => Promise<T>;
}

function openLogReader(path: string): { read: () => string; close: () => void } {
  const fd = openSync(path, 'r');
  const chunks: Buffer[] = [];
  return {
    read: () => {
      chunks.push(readFileSync(fd));
      return Buffer.concat(chunks).toString('utf8');
    },
    close: () => closeSync(fd),
  };
}

function readLock(lockPath: string): Lock | undefined {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Lock)
    : undefined;
}

function sourceShellLaunch(host: string, port: number): ProductionShellLaunch {
  return {
    mode: 'production',
    command: process.execPath,
    args: [
      CLI_SOURCE_ENTRY,
      'start',
      '--port',
      String(port),
      '--bind',
      host,
      '--no-open-browser',
      '--mode',
      'browser',
      '--react-shell-dist-dir',
      join(APP_PACKAGE_ROOT, 'dist'),
      '--idle-shutdown',
      'off',
    ],
  };
}

async function acquireProductionShellLifetime(): Promise<ProductionShellLifetime> {
  const deadlineAt = Date.now() + TEST_TIMEOUT_MS - REAP_MS;
  const teardown: Array<() => void | Promise<void>> = [];
  onTestFinished(() => runTeardownPhases(...teardown.reverse()));
  const root = mkdtempSync(join(tmpdir(), 'ok-lifetime-diagnostics-'));
  teardown.push(() => rmSync(root, { recursive: true, force: true }));
  const request = createViteStartupRequest('127.0.0.1');
  teardown.push(() => request.dispose());
  const serverLog = openServerLog('lifetime-diagnostics');
  teardown.push(() => closeServerLog(serverLog));
  const log = openLogReader(serverLog.path);
  teardown.push(log.close);
  const reportTail = holdServerLogTail(serverLog);
  teardown.push(reportTail.close);
  const contentDir = join(root, 'content');
  const viteCacheDir = join(root, 'vite-cache');
  mkdirSync(contentDir);
  mkdirSync(viteCacheDir);
  const messages: unknown[] = [];
  let stderr = '';
  let exit: Exit | undefined;
  const context = () =>
    `--- worker server lifetime stderr ---\n${stderr}\n--- server log ---\n${log.read()}`;
  const until = async <T>(what: string, attempt: () => T | undefined): Promise<T> => {
    const startedAt = Date.now();
    while (true) {
      const value = attempt();
      if (value !== undefined) return value;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `${what} within the ${Date.now() - startedAt}ms left of this test's budget\n${context()}`,
        );
      }
      await wait(Math.min(POLL_MS, remainingMs));
    }
  };

  const initialized = spawnSync(
    process.execPath,
    [CLI_SOURCE_ENTRY, 'init', '--no-mcp', '--no-skills', '--content-dir', '.', '--json'],
    { cwd: contentDir, encoding: 'utf8', timeout: deadlineAt - Date.now() },
  );
  if (initialized.status !== 0) {
    throw new Error(
      `ok init from source failed (status=${initialized.status}, signal=${initialized.signal}, error=${initialized.error?.message ?? 'none'})\n${initialized.stderr}`,
    );
  }
  const port = await getFreePort(request.host);
  const launch: WorkerServerLaunch = {
    request: { ...request, candidatePort: port },
    workerServerEnv: { [PRODUCTION_SHELL_ENV]: '1' },
    contentDir,
    viteCacheDir,
    serverLog: { path: serverLog.path, fd: 1 },
    serving: { kind: 'production-shell', launch: sourceShellLaunch(request.host, port) },
    command: null,
    reapMs: REAP_MS,
  };
  const child = spawn(process.execPath, [LIFETIME, JSON.stringify(launch)], {
    cwd: APP_PACKAGE_ROOT,
    stdio: ['ignore', serverLog.fd, 'pipe', 'ipc'],
  });
  const exited = new Promise<Exit>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const stderrStream = child.stderr;
  if (stderrStream === null) throw new Error('the worker server lifetime has no stderr pipe');
  const stderrClosed = new Promise<void>((resolve) => stderrStream.once('close', resolve));
  const closed = Promise.all([exited, stderrClosed]).then(([status]) => {
    exit = status;
  });
  teardown.push(async () => {
    if (child.connected) child.disconnect();
    await closed;
    if (stderr.length > 0) process.stderr.write(stderr);
  });
  stderrStream.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.on('message', (message: unknown) => messages.push(message));

  const lockPath = productionShellLockPath(contentDir);
  const boundLock = await until('the production-shell server did not bind its lock', () => {
    const lock = readLock(lockPath);
    return lock !== undefined && typeof lock.port === 'number' && lock.port > 0 ? lock : undefined;
  });
  return {
    child,
    boundLock,
    port,
    messages,
    serverLog: log.read,
    serverLogPath: serverLog.path,
    setupFailureReport: reportTail.report,
    exit: () => exit,
    until,
  };
}

test(
  'records the owner-loss trigger before stopping a production-shell server',
  async () => {
    const lifetime = await acquireProductionShellLifetime();
    expect(lifetime.boundLock.pid).toEqual(expect.any(Number));
    lifetime.child.disconnect();
    const record = await lifetime.until(
      'the lifetime did not record the loss of its owner',
      () => OWNER_LOSS_RECORD.exec(lifetime.serverLog()) ?? undefined,
    );
    expect(record.slice(1)).toEqual([
      'ipc-disconnect',
      String(process.pid),
      'true',
      String(lifetime.boundLock.pid),
      expect.any(String),
      'lock-bound',
    ]);
  },
  TEST_TIMEOUT_MS,
);

test(
  'leaves no owner-loss record when its owner requests the release of a production-shell server',
  async () => {
    const lifetime = await acquireProductionShellLifetime();
    await lifetime.until('the production-shell server did not log its URL', () =>
      lifetime.serverLog().includes(`http://127.0.0.1:${lifetime.port}`) ? true : undefined,
    );
    await new Promise<void>((resolve, reject) =>
      lifetime.child.send({ type: 'release' }, (error) =>
        error === null ? resolve() : reject(error),
      ),
    );
    const exit = await lifetime.until(
      'the lifetime did not close after its release',
      lifetime.exit,
    );
    expect(lifetime.messages).toContainEqual({ type: 'released', error: null });
    expect(exit).toEqual({ code: 0, signal: null });
    const log = lifetime.serverLog();
    expect(log).toContain(`http://127.0.0.1:${lifetime.port}`);
    expect(log).not.toContain('[worker-server-lifetime] owner-loss ');
  },
  TEST_TIMEOUT_MS,
);

test(
  'keeps the owner-loss record in the setup failure report after the lifetime removes the server log',
  async () => {
    const lifetime = await acquireProductionShellLifetime();
    lifetime.child.disconnect();
    await lifetime.until('the lifetime did not close after losing its owner', lifetime.exit);
    expect(existsSync(lifetime.serverLogPath)).toBe(false);
    expect(OWNER_LOSS_RECORD.exec(lifetime.setupFailureReport())?.[1]).toBe('ipc-disconnect');
  },
  TEST_TIMEOUT_MS,
);

test('keeps the owner-loss record in the setup failure report when later server output fills the tail', () => {
  const serverLog = openServerLog('lifetime-diagnostics-tail');
  const reportTail = holdServerLogTail(serverLog);
  onTestFinished(() =>
    runTeardownPhases(
      reportTail.close,
      () => closeServerLog(serverLog),
      () => rmSync(serverLog.path, { force: true }),
    ),
  );
  const record =
    '[worker-server-lifetime] owner-loss trigger=signal-SIGTERM ownerPid=2 ownerAlive=true serverPid=3 elapsedMs=4 readiness=lock-draining\n';
  writeSync(serverLog.fd, `${record}${'server shutdown output\n'.repeat(SERVER_LOG_TAIL_LINES)}`);
  const report = reportTail.report();
  expect(report).toContain('server shutdown output');
  expect(report).toContain(record);
});
