import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { constants } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { createConcurrencyGuard } from '../local-op-security.ts';
import { loggerFactory } from '../logger.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import { useIsolatedHome } from '../share/git-host-declarations.test-helper.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { createLocalOpRoutes } from './local-op-routes.ts';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
}));

class RecordedChild extends EventEmitter {
  pid = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: number[] = [];
  refuseCancellation = true;
  refuseTermination = false;
  _handle = {
    kill: (signal: number): number => {
      this.signals.push(signal);
      return (signal === constants.signals.SIGTERM && this.refuseCancellation) ||
        (signal === constants.signals.SIGKILL && this.refuseTermination)
        ? -constants.errno.EPERM
        : 0;
    },
  };
  kill = ChildProcess.prototype.kill;

  close(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit('close', 0, null);
  }
}

function guardNativeSpawn(): void {
  vi.spyOn(ChildProcess.prototype, 'spawn').mockImplementation(() => {
    throw new Error('This recording-only test must not spawn a real process');
  });
}

async function createRecordingServer(getSyncEngine?: () => SyncEngine | null) {
  const group = createLocalOpRoutes({
    projectDir: undefined,
    contentDir: home(),
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => true,
    localOpCliArgs: ['recorded-auth-cli'],
    localOpGuard: createConcurrencyGuard(),
    getSyncEngine,
    authStreamHeartbeatMs: undefined,
    embeddingsSecretsFile: undefined,
    readSemanticProviderConfig: undefined,
    semanticSearch: undefined,
  });
  const server = createServer((req, res) => {
    const dispatch = group.table.resolve(req.url ?? '/')?.dispatch;
    if (!dispatch) {
      res.writeHead(404).end();
      return;
    }
    void dispatch(req, res);
  });
  const { baseUrl } = await listenOnLoopback(server);
  return {
    group,
    baseUrl,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function drainPriorEvents(baseUrl: string): Promise<void> {
  const barrier = await fetch(`${baseUrl}/test-event-loop-barrier`);
  await barrier.text();
}

const verification = {
  type: 'verification',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
};

function postAuth(baseUrl: string, route: 'login' | 'pat', body: object): Promise<Response> {
  return fetch(`${baseUrl}/api/local-op/auth/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const home = useIsolatedHome();
afterEach(() => {
  spawn.mockReset();
  vi.restoreAllMocks();
});

test('shutdown retains a live auth child after cancellation cannot deliver its signal', async () => {
  guardNativeSpawn();
  const child = new RecordedChild();
  spawn.mockImplementation(() => {
    queueMicrotask(() => child.stdout.write(`${JSON.stringify(verification)}\n`));
    return child;
  });
  const fixture = await createRecordingServer();
  let shutdown: Promise<void> | undefined;
  try {
    const login = await postAuth(fixture.baseUrl, 'login', {});
    expect(login.status).toBe(200);
    const cancel = await fetch(`${fixture.baseUrl}/api/local-op/auth/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(cancel.status).toBe(200);
    await cancel.text();
    expect(await login.text()).toContain('verification');
    expect(child.exitCode).toBeNull();
    expect(child.signals).toEqual([constants.signals.SIGTERM]);
    let destroyed = false;
    shutdown = fixture.group.shutdown().then(() => {
      destroyed = true;
    });
    expect(child.signals).toEqual([constants.signals.SIGTERM, constants.signals.SIGKILL]);
    await drainPriorEvents(fixture.baseUrl);
    expect(destroyed).toBe(false);
    child.close();
    await shutdown;
    expect(destroyed).toBe(true);
  } finally {
    child.close();
    await shutdown;
    await fixture.close();
  }
});

test('shutdown waits for close when the native signal reports an already-dead child', async () => {
  guardNativeSpawn();
  const child = new RecordedChild();
  child._handle.kill = (signal: number) => {
    child.signals.push(signal);
    return -constants.errno.ESRCH;
  };
  spawn.mockImplementation(() => {
    queueMicrotask(() => child.stdout.write(`${JSON.stringify(verification)}\n`));
    return child;
  });
  const fixture = await createRecordingServer();
  let shutdown: Promise<unknown> | undefined;
  try {
    const login = await postAuth(fixture.baseUrl, 'login', {});
    expect(login.status).toBe(200);
    let settled = false;
    shutdown = fixture.group.shutdown().then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await drainPriorEvents(fixture.baseUrl);
    expect(child.signals).toEqual([constants.signals.SIGKILL]);
    expect(settled).toBe(false);
    child.close();
    expect(await shutdown).toBeNull();
    expect(settled).toBe(true);
  } finally {
    child.close();
    await shutdown;
    await fixture.close();
  }
});

test('shutdown drains another auth child when one termination is refused', async () => {
  guardNativeSpawn();
  const refused = new RecordedChild();
  refused.refuseCancellation = false;
  refused.refuseTermination = true;
  const draining = new RecordedChild();
  const children = [refused, draining];
  spawn.mockImplementation(() => {
    const child = children.shift();
    if (!child) throw new Error('Unexpected auth child');
    queueMicrotask(() => child.stdout.write(`${JSON.stringify(verification)}\n`));
    return child;
  });
  const fixture = await createRecordingServer();
  let shutdown: Promise<unknown> | undefined;
  try {
    const first = await postAuth(fixture.baseUrl, 'login', {});
    expect(first.status).toBe(200);
    const second = await postAuth(fixture.baseUrl, 'login', {});
    expect(second.status).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(2);
    let settled = false;
    shutdown = fixture.group.shutdown().then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await drainPriorEvents(fixture.baseUrl);
    expect(refused.signals).toContain(constants.signals.SIGKILL);
    expect(draining.signals).toContain(constants.signals.SIGKILL);
    expect(refused.exitCode).toBeNull();
    expect(draining.exitCode).toBeNull();
    expect(settled).toBe(false);
    draining.close();
    expect(await shutdown).toBeInstanceOf(AggregateError);
    expect(await fixture.group.shutdown().catch((error: unknown) => error)).toBeInstanceOf(
      AggregateError,
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  } finally {
    refused.close();
    draining.close();
    await shutdown;
    await fixture.close();
  }
});

test('shutdown suppresses a buffered device-code completion and sync resume', async () => {
  guardNativeSpawn();
  const child = new RecordedChild();
  spawn.mockImplementation(() => {
    queueMicrotask(() => child.stdout.write(`${JSON.stringify(verification)}\n`));
    return child;
  });
  const notifyCredentialsChanged = vi.fn(async () => {});
  const refreshPushPermission = vi.fn(async () => null);
  const engine = { notifyCredentialsChanged, refreshPushPermission } as unknown as SyncEngine;
  const fixture = await createRecordingServer(() => engine);
  let shutdown: Promise<void> | undefined;
  try {
    const login = await postAuth(fixture.baseUrl, 'login', {});
    expect(login.status).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(1);
    shutdown = fixture.group.shutdown();
    child.stdout.write(
      `${JSON.stringify({ type: 'complete', host: 'github.com', login: 'octocat' })}\n`,
    );
    await drainPriorEvents(fixture.baseUrl);
    expect(child.exitCode).toBeNull();
    const resumedBeforeClose = notifyCredentialsChanged.mock.calls.length;
    const refreshedBeforeClose = refreshPushPermission.mock.calls.length;
    child.close();
    await shutdown;
    const events = (await login.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(verification);
    expect.soft(events).not.toContainEqual(expect.objectContaining({ type: 'complete' }));
    expect.soft(resumedBeforeClose).toBe(0);
    expect.soft(refreshedBeforeClose).toBe(0);
  } finally {
    child.close();
    await shutdown;
    await fixture.close();
  }
});

test('shutdown suppresses a late token completion and sync resume', async () => {
  guardNativeSpawn();
  const child = new RecordedChild();
  const spawned = Promise.withResolvers<void>();
  spawn.mockImplementation(() => {
    spawned.resolve();
    return child;
  });
  const notifyCredentialsChanged = vi.fn(async () => {});
  const refreshPushPermission = vi.fn(async () => null);
  const engine = { notifyCredentialsChanged, refreshPushPermission } as unknown as SyncEngine;
  const fixture = await createRecordingServer(() => engine);
  let shutdown: Promise<void> | undefined;
  let response: Promise<Response> | undefined;
  try {
    response = postAuth(fixture.baseUrl, 'pat', { token: 'fixture-token', host: 'github.com' });
    await spawned.promise;
    expect(spawn).toHaveBeenCalledTimes(1);
    await drainPriorEvents(fixture.baseUrl);
    let shutdownSettled = false;
    shutdown = fixture.group.shutdown().then(() => {
      shutdownSettled = true;
    });
    await drainPriorEvents(fixture.baseUrl);
    const finishedBeforeChild = shutdownSettled;
    child.stdout.write(
      `${JSON.stringify({ type: 'complete', host: 'github.com', login: 'octocat' })}\n`,
    );
    child.close();
    const result = await response;
    await shutdown;
    expect.soft(result.ok).toBe(false);
    expect.soft(notifyCredentialsChanged).not.toHaveBeenCalled();
    expect.soft(refreshPushPermission).not.toHaveBeenCalled();
    expect.soft(finishedBeforeChild).toBe(false);
  } finally {
    child.close();
    await shutdown;
    await response;
    await fixture.close();
  }
});

test('shutdown settles after a synchronous repos launch failure', async () => {
  guardNativeSpawn();
  spawn.mockImplementation(() => {
    throw new Error('recorded launch failure');
  });
  const group = createLocalOpRoutes({
    projectDir: undefined,
    contentDir: home(),
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => true,
    localOpCliArgs: ['recorded-auth-cli'],
    localOpGuard: createConcurrencyGuard(),
    getSyncEngine: undefined,
    authStreamHeartbeatMs: undefined,
    embeddingsSecretsFile: undefined,
    readSemanticProviderConfig: undefined,
    semanticSearch: undefined,
  });
  const failed = Promise.withResolvers<unknown>();
  const server = createServer((req, res) => {
    const dispatch = group.table.resolve(req.url ?? '/')?.dispatch;
    if (!dispatch) {
      res.writeHead(404).end();
      return;
    }
    void dispatch(req, res).catch((error) => {
      failed.resolve(error);
      res.destroy();
    });
  });
  try {
    const { baseUrl } = await listenOnLoopback(server);
    const request = fetch(`${baseUrl}/api/local-op/auth/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => undefined);
    expect(await failed.promise).toMatchObject({ message: 'recorded launch failure' });
    expect(spawn).toHaveBeenCalledTimes(1);
    let settled = false;
    const shutdown = group.shutdown().then(() => {
      settled = true;
    });
    await drainPriorEvents(baseUrl);
    expect(settled).toBe(true);
    await shutdown;
    await request;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
