import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Browser, WorkerInfo } from '@playwright/test';
import { afterEach, describe, expect, test } from 'vitest';
import { seedRequiredFixtureFiles } from '../stress/_helpers/fixtures.ts';
import { E2E_SERVING_ENV } from '../stress/_helpers/prebuilt/prebuilt-serving.ts';
import { leaseWorkerServer, type ServerLease } from '../stress/_helpers/reuse/lease-fixture.ts';
import {
  type LeaseOutcome,
  type LeaseRequest,
  REUSE_RUN_ENV,
  REUSE_SOCKET_ENV,
} from '../stress/_helpers/reuse/lease-protocol.ts';
import { WorkerServerSupervisor } from '../stress/_helpers/reuse/server-supervisor.ts';
import {
  connectLeaseClient,
  type SupervisorEndpoint,
  serveSupervisor,
} from '../stress/_helpers/reuse/supervisor-socket.ts';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/seed-key.ts';
import {
  contractServerLauncher,
  failContractServerReadiness,
} from './contract-dev-server.test-helper.ts';

const CONFIG_FILE = '/worktree/packages/app/playwright.config.ts';
const PROJECT = 'chromium';
const WORKTREE = realpathSync(join(APP_PACKAGE_ROOT, '..', '..'));
const CALL_MS = 30_000;
const LEASE_ENV_NAMES = [REUSE_SOCKET_ENV, REUSE_RUN_ENV, E2E_SERVING_ENV] as const;

const WORKER_INFO = {
  parallelIndex: 0,
  workerIndex: 0,
  config: { configFile: CONFIG_FILE },
  project: { name: PROJECT },
} as WorkerInfo;

const BROWSER_THE_REUSED_PATH_NEVER_OPENS = {} as Browser;

interface Rig {
  readonly releaseFails: boolean;
  readonly supervisor: WorkerServerSupervisor;
  readonly launcher: ReturnType<typeof contractServerLauncher>;
  readonly scratch: string;
  request(overrides: Partial<LeaseRequest>): LeaseRequest;
}

const openRigs: Rig[] = [];
const openEndpoints: SupervisorEndpoint[] = [];
const openProxies: Server[] = [];
const savedEnv = new Map(LEASE_ENV_NAMES.map((name) => [name, process.env[name]]));

const RELEASE_FAILURE = 'the server stopped, but its release reported a failure';

function makeRig({ releaseFails = false }: { releaseFails?: boolean } = {}): Rig {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lease-safety-scratch-')));
  const launcher = contractServerLauncher();
  const supervisor = new WorkerServerSupervisor({
    okRoot: WORKTREE,
    launch: releaseFails
      ? async (slot, env) => {
          const owned = await launcher.launch(slot, env);
          return {
            ...owned,
            release: async () => {
              await owned.release();
              throw new Error(RELEASE_FAILURE);
            },
          };
        }
      : launcher.launch,
    identityTimeoutMs: 2_000,
  });
  const rig: Rig = {
    releaseFails,
    supervisor,
    launcher,
    scratch,
    request: (overrides) => ({
      worktree: WORKTREE,
      config: `${CONFIG_FILE}#${PROJECT}`,
      run: 'run-a',
      slot: 0,
      workerServerEnv: {},
      serverMode: 'dev',
      ...overrides,
    }),
  };
  openRigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const proxy of openProxies.splice(0)) {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
  for (const endpoint of openEndpoints.splice(0)) await endpoint.close();
  for (const rig of openRigs.splice(0)) {
    await rig.supervisor.shutdown().catch((error: unknown) => {
      if (!rig.releaseFails || !String(error).includes(RELEASE_FAILURE)) throw error;
    });
    rmSync(rig.scratch, { recursive: true, force: true });
  }
});

function granted(outcome: LeaseOutcome): Extract<LeaseOutcome, { kind: 'granted' }> {
  if (outcome.kind !== 'granted') {
    throw new Error(`expected a granted lease, got ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome;
}

function refusal(outcome: LeaseOutcome): Extract<LeaseOutcome, { kind: 'refused' }> {
  if (outcome.kind !== 'refused') {
    throw new Error(`expected a refusal, got a lease on ${outcome.baseURL}`);
  }
  return outcome;
}

async function serving(baseURL: string): Promise<boolean> {
  try {
    await fetch(`${baseURL}/__ok-test-server-identity`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

async function identityNonce(baseURL: string): Promise<unknown> {
  const response = await fetch(`${baseURL}/__ok-test-server-identity`);
  return ((await response.json()) as { nonce?: unknown }).nonce;
}

async function idleSeededSlot(options: { releaseFails?: boolean } = {}): Promise<{
  rig: Rig;
  endpoint: SupervisorEndpoint;
  slot: Extract<LeaseOutcome, { kind: 'granted' }>;
}> {
  const rig = makeRig(options);
  const endpoint = await serveSupervisor(rig.supervisor, join(rig.scratch, 'supervisor.sock'));
  openEndpoints.push(endpoint);
  const client = await connectLeaseClient(endpoint.socketPath, 5_000);
  try {
    const slot = granted(await client.acquire(rig.request({ run: 'run-a' }), CALL_MS));
    seedRequiredFixtureFiles(slot.contentDir);
    await client.release(slot.token, false, CALL_MS);
    return { rig, endpoint, slot };
  } finally {
    client.close();
  }
}

async function connectionDroppedAtRelease(
  endpoint: SupervisorEndpoint,
  scratch: string,
): Promise<string> {
  const proxyPath = join(scratch, 'drop.sock');
  const proxy = createServer((worker) => {
    const supervisor = connect(endpoint.socketPath);
    supervisor.on('error', () => worker.destroy());
    worker.on('error', () => supervisor.destroy());
    worker.on('end', () => supervisor.end());
    supervisor.pipe(worker);
    const lines = createInterface({ input: worker, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on('line', (line) => {
      if ((JSON.parse(line) as { op?: unknown }).op === 'release') {
        supervisor.destroy();
        worker.destroy();
        return;
      }
      supervisor.write(`${line}\n`);
    });
  });
  openProxies.push(proxy);
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen({ path: proxyPath }, () => resolve());
  });
  return proxyPath;
}

async function leaseThroughWorkerFixture(
  socketPath: string,
  run: string,
): Promise<{ lease: ServerLease | undefined; heldDuringUse: boolean | undefined }> {
  process.env[REUSE_SOCKET_ENV] = socketPath;
  process.env[REUSE_RUN_ENV] = run;
  delete process.env[E2E_SERVING_ENV];
  let lease: ServerLease | undefined;
  let heldDuringUse: boolean | undefined;
  await leaseWorkerServer(
    { workerServerEnv: {}, browser: BROWSER_THE_REUSED_PATH_NEVER_OPENS },
    async (offered) => {
      lease = offered;
      if (offered?.kind === 'leased') heldDuringUse = (await offered.verify()).held;
    },
    WORKER_INFO,
  );
  return { lease, heldDuringUse };
}

describe('a reused slot that fails readiness after its reset', () => {
  test('a slot whose reset and readiness checks pass is reused by the next run', async () => {
    const { endpoint, slot } = await idleSeededSlot();

    const { lease, heldDuringUse } = await leaseThroughWorkerFixture(endpoint.socketPath, 'run-b');

    expect(lease?.kind).toBe('leased');
    expect(lease?.note).toBe(`slot 0: reused the owned server at ${slot.baseURL}`);
    expect(heldDuringUse).toBe(true);
    expect(await serving(slot.baseURL)).toBe(true);
  });

  test('a slot whose API config stops answering after its reset is discarded and the worker starts its own server', async () => {
    const { rig, endpoint, slot } = await idleSeededSlot();
    const [server] = rig.launcher.launched;
    if (server === undefined) throw new Error('no server was launched');
    await failContractServerReadiness(server, 'api-config');

    const { lease, heldDuringUse } = await leaseThroughWorkerFixture(endpoint.socketPath, 'run-b');

    expect(lease).toEqual({
      kind: 'fresh',
      note: 'slot 0: the leased server could not be reset (/api/config returned status 503, expected 200), so it was discarded and this worker starts its own server',
    });
    expect(heldDuringUse).toBeUndefined();
    expect(await serving(slot.baseURL)).toBe(false);
  });

  test('a slot whose collaboration endpoint stops syncing after its reset is discarded and the worker starts its own server', async () => {
    const { rig, endpoint, slot } = await idleSeededSlot();
    const [server] = rig.launcher.launched;
    if (server === undefined) throw new Error('no server was launched');
    await failContractServerReadiness(server, 'collab');

    const { lease, heldDuringUse } = await leaseThroughWorkerFixture(endpoint.socketPath, 'run-b');

    expect(lease).toEqual({
      kind: 'fresh',
      note: 'slot 0: the leased server could not be reset (/collab sync round-trip did not complete within 10000ms), so it was discarded and this worker starts its own server',
    });
    expect(heldDuringUse).toBeUndefined();
    expect(await serving(slot.baseURL)).toBe(false);
  });
});

describe('a discarded slot whose release fails', () => {
  test('the reset failure stays the reason, the release failure is reported beside it, and the worker still starts its own server', async () => {
    const { rig, endpoint, slot } = await idleSeededSlot({ releaseFails: true });
    const [server] = rig.launcher.launched;
    if (server === undefined) throw new Error('no server was launched');
    await failContractServerReadiness(server, 'api-config');

    const { lease, heldDuringUse } = await leaseThroughWorkerFixture(endpoint.socketPath, 'run-b');

    expect(lease).toEqual({
      kind: 'fresh',
      note: `slot 0: the leased server could not be reset (/api/config returned status 503, expected 200), so this worker starts its own server; the supervisor did not confirm discarding the leased server (the supervisor refused the request: ${RELEASE_FAILURE})`,
    });
    expect(heldDuringUse).toBeUndefined();
    expect(await serving(slot.baseURL)).toBe(false);
  });
});

describe('a discarded slot whose lease connection fails as the worker releases it', () => {
  test('the note claims no discard, and the supervisor discards the server rather than returning it to the slot', async () => {
    const { rig, endpoint, slot } = await idleSeededSlot();
    const [server] = rig.launcher.launched;
    if (server === undefined) throw new Error('no server was launched');
    const servedNonce = await identityNonce(slot.baseURL);
    await failContractServerReadiness(server, 'api-config');
    const dropping = await connectionDroppedAtRelease(endpoint, rig.scratch);

    const { lease, heldDuringUse } = await leaseThroughWorkerFixture(dropping, 'run-b');

    expect(lease).toEqual({
      kind: 'fresh',
      note: `slot 0: the leased server could not be reset (/api/config returned status 503, expected 200), so this worker starts its own server; the supervisor did not confirm discarding the leased server (the supervisor at ${dropping} closed the lease connection)`,
    });
    expect(heldDuringUse).toBeUndefined();
    await expect.poll(() => rig.supervisor.status()[0]?.leasedBy).toBeNull();
    const next = granted(await rig.supervisor.acquire(rig.request({ run: 'run-c' })));
    expect(next.launched).toBe(true);
    expect(next.relaunchedBecause).toBe('its holder disconnected without releasing it');
    expect(await identityNonce(next.baseURL)).not.toBe(servedNonce);
  }, 60_000);
});

describe('a worker environment change on a held slot', () => {
  test('a run with a different worker environment is refused as busy while the slot is held, and restarts it once the slot is idle', async () => {
    const rig = makeRig();
    const env = { OK_TEST_FEATURE: 'on' };
    const changed = { OK_TEST_FEATURE: 'off' };
    const held = granted(await rig.supervisor.acquire(rig.request({ workerServerEnv: env })));
    const nonce = await identityNonce(held.baseURL);

    const whileHeld = refusal(
      await rig.supervisor.acquire(rig.request({ run: 'run-b', workerServerEnv: changed })),
    );
    expect(whileHeld.reason).toBe('busy');
    expect(whileHeld.detail).toBe('slot 0 is leased to run run-a');
    expect(await rig.supervisor.verify(held.token)).toEqual({ held: true });
    expect(await identityNonce(held.baseURL)).toBe(nonce);
    expect(rig.launcher.environments).toEqual([env]);

    await rig.supervisor.release(held.token, false);
    const onceIdle = granted(
      await rig.supervisor.acquire(rig.request({ run: 'run-b', workerServerEnv: changed })),
    );
    expect(onceIdle.launched).toBe(true);
    expect(onceIdle.relaunchedBecause).toBe('its workerServerEnv differs in OK_TEST_FEATURE');
    expect(await serving(held.baseURL)).toBe(false);
    expect(rig.launcher.environments).toEqual([env, changed]);
  }, 60_000);
});
