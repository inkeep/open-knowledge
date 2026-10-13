import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, WorkerInfo } from '@playwright/test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WORKER_SERVER_SETUP_STARVATION_LINE_MS } from '../stress/_helpers/fixtures.ts';
import { E2E_SERVING_ENV } from '../stress/_helpers/prebuilt/prebuilt-serving.ts';
import { leaseWorkerServer, type ServerLease } from '../stress/_helpers/reuse/lease-fixture.ts';
import { REUSE_RUN_ENV, REUSE_SOCKET_ENV } from '../stress/_helpers/reuse/lease-protocol.ts';
import {
  type LaunchOwnedServer,
  WorkerServerSupervisor,
} from '../stress/_helpers/reuse/server-supervisor.ts';
import {
  connectLeaseClient,
  type SupervisorEndpoint,
  serveSupervisor,
} from '../stress/_helpers/reuse/supervisor-socket.ts';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/seed-key.ts';
import { contractServerLauncher } from './contract-dev-server.test-helper.ts';

const WORKTREE = realpathSync(join(APP_PACKAGE_ROOT, '..', '..'));
const CALL_MS = 30_000;
const DISCARD_MS = 30_000;
const LEASE_ENV_NAMES = [REUSE_SOCKET_ENV, REUSE_RUN_ENV, E2E_SERVING_ENV] as const;

const WORKER_INFO = {
  parallelIndex: 0,
  workerIndex: 0,
  config: { configFile: '/worktree/packages/app/playwright.config.ts' },
  project: { name: 'chromium' },
} as WorkerInfo;

const BROWSER_THE_FAILED_LEASE_NEVER_OPENS = {} as Browser;

const savedEnv = new Map(LEASE_ENV_NAMES.map((name) => [name, process.env[name]]));
const openEndpoints: SupervisorEndpoint[] = [];
const openSupervisors: WorkerServerSupervisor[] = [];
const scratchDirs: string[] = [];
const openGates: Array<(launch: boolean) => void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const openGate of openGates.splice(0)) openGate(false);
  for (const endpoint of openEndpoints.splice(0)) await endpoint.close();
  for (const supervisor of openSupervisors.splice(0)) await supervisor.shutdown();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface GatedSupervisor {
  readonly supervisor: WorkerServerSupervisor;
  readonly endpoint: SupervisorEndpoint;
  readonly launcher: ReturnType<typeof contractServerLauncher>;
  readonly launchStarted: Promise<void>;
  openGate(launch: boolean): void;
}

async function supervisorWithGatedLaunch(): Promise<GatedSupervisor> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lease-acquire-failure-')));
  scratchDirs.push(scratch);
  const launcher = contractServerLauncher();
  let markStarted: () => void = () => {};
  const launchStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let openGate: (launch: boolean) => void = () => {};
  const gate = new Promise<boolean>((resolve) => {
    openGate = resolve;
  });
  openGates.push(openGate);
  const launch: LaunchOwnedServer = async (slot, env) => {
    markStarted();
    if (!(await gate)) throw new Error('the test closed the launch gate');
    return launcher.launch(slot, env);
  };
  const supervisor = new WorkerServerSupervisor({
    okRoot: WORKTREE,
    launch,
    identityTimeoutMs: 2_000,
  });
  openSupervisors.push(supervisor);
  const endpoint = await serveSupervisor(supervisor, join(scratch, 'supervisor.sock'));
  openEndpoints.push(endpoint);
  return { supervisor, endpoint, launcher, launchStarted, openGate };
}

function leaseThroughWorkerFixture(
  socketPath: string,
  whileInUse: (lease: ServerLease | undefined) => Promise<void>,
): Promise<void> {
  process.env[REUSE_SOCKET_ENV] = socketPath;
  process.env[REUSE_RUN_ENV] = 'run-b';
  delete process.env[E2E_SERVING_ENV];
  return leaseWorkerServer(
    { workerServerEnv: {}, browser: BROWSER_THE_FAILED_LEASE_NEVER_OPENS },
    whileInUse,
    WORKER_INFO,
  );
}

function failureOf(work: Promise<void>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function serving(baseURL: string): Promise<boolean> {
  try {
    await fetch(`${baseURL}/__ok-test-server-identity`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

describe('a worker whose lease request fails', () => {
  test('a supervisor that shuts down while the slot is starting leaves the worker on its own server, with a note naming the closed connection', async () => {
    const rig = await supervisorWithGatedLaunch();
    const offered: Array<ServerLease | undefined> = [];

    const fixtureFailure = failureOf(
      leaseThroughWorkerFixture(rig.endpoint.socketPath, async (lease) => {
        offered.push(lease);
      }),
    );
    await rig.launchStarted;
    const operator = await connectLeaseClient(rig.endpoint.socketPath, 5_000);
    try {
      await operator.shutdown(CALL_MS);
    } finally {
      operator.close();
    }

    expect(await fixtureFailure).toBeUndefined();
    expect(offered).toEqual([
      {
        kind: 'fresh',
        note: `slot 0: the lease request failed (the supervisor at ${rig.endpoint.socketPath} closed the lease connection), so this worker starts its own server`,
      },
    ]);
    rig.openGate(false);
    expect(await rig.endpoint.closed).toEqual({ released: true });
    await expect.poll(() => rig.supervisor.status()[0]?.leasedBy).toBeNull();
    expect(rig.launcher.launched).toEqual([]);
  });

  test('a supervisor that does not answer before the setup deadline leaves the worker on its own server, and the server it launches afterwards is discarded rather than held for that worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const rig = await supervisorWithGatedLaunch();
    let finishUse: () => void = () => {};
    const useMayFinish = new Promise<void>((resolve) => {
      finishUse = resolve;
    });
    let markOffered: (lease: ServerLease | undefined) => void = () => {};
    const offered = new Promise<ServerLease | undefined>((resolve) => {
      markOffered = resolve;
    });

    const fixtureFailure = failureOf(
      leaseThroughWorkerFixture(rig.endpoint.socketPath, async (lease) => {
        markOffered(lease);
        await useMayFinish;
      }),
    );
    await rig.launchStarted;
    await vi.advanceTimersByTimeAsync(WORKER_SERVER_SETUP_STARVATION_LINE_MS);
    vi.useRealTimers();
    const first = await Promise.race([
      offered.then((lease) => ({ offered: lease })),
      fixtureFailure.then((failure) => ({ fixtureEndedWith: failure })),
    ]);

    expect(first).toEqual({
      offered: {
        kind: 'fresh',
        note: `slot 0: the lease request failed (the supervisor did not answer acquire within ${WORKER_SERVER_SETUP_STARVATION_LINE_MS}ms), so this worker starts its own server`,
      },
    });
    expect(rig.supervisor.status()[0]?.leasedBy).toBe('run-b');
    rig.openGate(true);
    await expect
      .poll(() => rig.supervisor.status()[0]?.leasedBy, { timeout: DISCARD_MS })
      .toBeNull();
    const [lateServer] = rig.launcher.launched;
    if (lateServer === undefined) throw new Error('the supervisor launched no server for the slot');
    await expect.poll(() => serving(lateServer.baseURL), { timeout: DISCARD_MS }).toBe(false);
    expect(rig.supervisor.status()[0]?.baseURL).toBeNull();

    finishUse();
    expect(await fixtureFailure).toBeUndefined();
  }, 60_000);
});
