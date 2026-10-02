import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { createHttpApp } from './http/http-app.ts';
import { getLogger, loggerFactory, type PinoLogger } from './logger.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';
import { createServer } from './server-factory.ts';
import { useIsolatedHome } from './share/git-host-declarations.test-helper.ts';

const auth = vi.hoisted(() => ({
  cli: 'recorded-auth-cli',
  child: undefined as object | undefined,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (args[0] !== auth.cli) return actual.spawn(...args);
      if (auth.child === undefined) throw new Error('Unexpected auth child');
      return auth.child;
    },
  };
});

class RecordedChild extends EventEmitter {
  pid = 42;
  spawnfile = auth.cli;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: number[] = [];
  _handle = {
    kill: (signal: number): number => {
      this.signals.push(signal);
      return signal === constants.signals.SIGKILL ? -constants.errno.EPERM : 0;
    },
  };
  kill = ChildProcess.prototype.kill;

  close(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit('close', 0, null);
  }
}

function guardNativeAuthSpawn(): void {
  const prototype = ChildProcess.prototype as ChildProcess & {
    spawn(options: { file: string }): unknown;
  };
  const nativeSpawn = prototype.spawn;
  vi.spyOn(prototype, 'spawn').mockImplementation(function (this: ChildProcess, options) {
    if (options.file === auth.cli) {
      throw new Error('This recording-only test must not spawn the auth CLI');
    }
    return nativeSpawn.call(this, options);
  });
}

interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
  payload: Record<string, unknown>;
}

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  loggerFactory.configure({
    loggerFactory: () => {
      const record =
        (level: LogEntry['level']) =>
        (payload: unknown, msg: string): void => {
          entries.push({ level, msg, payload: (payload as Record<string, unknown>) ?? {} });
        };
      return {
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        debug: record('debug'),
      } as unknown as PinoLogger;
    },
  });
  return entries;
}

const home = useIsolatedHome();
afterEach(() => {
  auth.child = undefined;
  vi.restoreAllMocks();
  loggerFactory.reset();
});

test('destroy rejects with a refused auth subprocess termination and records the phase error', async () => {
  guardNativeAuthSpawn();
  const logs = captureLogs();
  const child = new RecordedChild();
  auth.child = child;
  child.stdout.write(
    `${JSON.stringify({
      type: 'verification',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
    })}\n`,
  );
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-local-op-shutdown-'));
  const instance = createServer({
    contentDir: projectDir,
    projectDir,
    gitEnabled: false,
    quiet: true,
    localOpCliArgs: [auth.cli],
    configHomedirOverride: home(),
  });
  const notFound = (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(404).end();
  };
  const { requestListener } = createHttpApp({
    nativeApi: instance.nativeApi,
    legacyDispatch: notFound,
    contentDispatch: notFound,
    log: getLogger('test'),
  });
  const http = createHttpServer(requestListener);
  try {
    await instance.ready;
    const { baseUrl } = await listenOnLoopback(http);
    const login = await fetch(`${baseUrl}/api/local-op/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(login.status).toBe(200);

    const outcome = await instance.destroy().then(
      () => 'resolved',
      (error: unknown) => error,
    );

    expect(child.signals).toContain(constants.signals.SIGKILL);
    const refusal = `Could not stop auth subprocess ${child.pid} (${auth.cli})`;
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: refusal,
        cause: expect.objectContaining({ code: 'EPERM' }),
      }),
    ]);
    const summaries = logs.filter(
      (entry) => entry.level === 'warn' && entry.msg.includes('shutdown flushed'),
    );
    expect(summaries.flatMap((entry) => entry.payload.phaseErrors)).toContainEqual({
      phase: 'local-op-subprocess-shutdown',
      error: refusal,
    });
  } finally {
    child.close();
    await instance.destroy().catch(() => undefined);
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(projectDir, { recursive: true, force: true });
  }
});
