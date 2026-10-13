import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { LeaseOutcome, LeaseRequest } from '../stress/_helpers/reuse/lease-protocol.ts';
import {
  type LaunchOwnedServer,
  type OwnedServer,
  WorkerServerSupervisor,
} from '../stress/_helpers/reuse/server-supervisor.ts';
import {
  connectLeaseClient,
  type SupervisorEndpoint,
  serveSupervisor,
} from '../stress/_helpers/reuse/supervisor-socket.ts';
import { contractServerLauncher } from './contract-dev-server.test-helper.ts';

const STRESS_CONFIG = '/worktree/packages/app/playwright.config.ts#chromium';
const CALL_MS = 30_000;
const RELEASE_FAILURE = 'the server stopped, but its release reported a failure';

interface Rig {
  readonly supervisor: WorkerServerSupervisor;
  readonly launcher: ReturnType<typeof contractServerLauncher>;
  readonly okRoot: string;
  request(overrides: Partial<LeaseRequest>): LeaseRequest;
}

const openRigs: Rig[] = [];
const openEndpoints: SupervisorEndpoint[] = [];
const openListeners: Server[] = [];
const openGates: Array<() => void> = [];

afterEach(async () => {
  for (const open of openGates.splice(0)) open();
  for (const listener of openListeners.splice(0)) {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  for (const endpoint of openEndpoints.splice(0)) await endpoint.close();
  for (const rig of openRigs.splice(0)) {
    await rig.supervisor.shutdown().catch((error: unknown) => {
      if (!String(error).includes(RELEASE_FAILURE)) throw error;
    });
    rmSync(rig.okRoot, { recursive: true, force: true });
  }
});

function makeRig(wrap: (launch: LaunchOwnedServer) => LaunchOwnedServer = (launch) => launch): Rig {
  const okRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lease-shutdown-root-')));
  mkdirSync(join(okRoot, 'packages', 'server', 'src'), { recursive: true });
  mkdirSync(join(okRoot, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(okRoot, 'packages', 'server', 'src', 'boot.ts'), 'export const boot = 1;\n');
  writeFileSync(join(okRoot, 'packages', 'app', 'src', 'App.tsx'), 'export const app = 1;\n');
  const launcher = contractServerLauncher();
  const supervisor = new WorkerServerSupervisor({
    okRoot,
    launch: wrap(launcher.launch),
    identityTimeoutMs: 5_000,
  });
  const rig: Rig = {
    supervisor,
    launcher,
    okRoot,
    request: (overrides) => ({
      worktree: okRoot,
      config: STRESS_CONFIG,
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

interface Gate {
  readonly reached: Promise<void>;
  readonly opened: Promise<void>;
  open(): void;
  markReached(): void;
}

function gate(): Gate {
  let markReached: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  openGates.push(open);
  return { reached, opened, open, markReached };
}

function granted(outcome: LeaseOutcome): Extract<LeaseOutcome, { kind: 'granted' }> {
  if (outcome.kind !== 'granted') {
    throw new Error(`expected a granted lease, got ${outcome.reason}: ${outcome.detail}`);
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

function settledFlag(work: Promise<unknown>): () => boolean {
  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

async function afterPendingTurns(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await nextTurn();
}

function warnings(): string[] {
  const lines: string[] = [];
  const passThrough = console.warn.bind(console);
  const warn = vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
    const line = parts.map(String).join(' ');
    if (line.startsWith('[server reuse]')) lines.push(line);
    else passThrough(...parts);
  });
  onTestFinished(() => warn.mockRestore());
  return lines;
}

function releaseFailsAfterReleasing(launch: LaunchOwnedServer, held?: Gate): LaunchOwnedServer {
  return async (slot, workerServerEnv) => {
    const owned = await launch(slot, workerServerEnv);
    return {
      ...owned,
      release: async () => {
        await owned.release();
        if (held !== undefined && slot === 1) {
          held.markReached();
          await held.opened;
        }
        throw new Error(`${RELEASE_FAILURE} for slot ${slot}`);
      },
    };
  };
}

async function idleSlots(rig: Rig, slots: readonly number[]): Promise<OwnedServerURL[]> {
  const urls: OwnedServerURL[] = [];
  for (const slot of slots) {
    const lease = granted(await rig.supervisor.acquire(rig.request({ slot })));
    await rig.supervisor.release(lease.token, false);
    urls.push({ slot, baseURL: lease.baseURL });
  }
  return urls;
}

interface OwnedServerURL {
  readonly slot: number;
  readonly baseURL: string;
}

async function identityHeldBehind(held: Gate, server: OwnedServer): Promise<string> {
  const listener = createServer((request, response) => {
    if (request.url !== '/__ok-test-server-identity') {
      response.statusCode = 404;
      response.end();
      return;
    }
    held.markReached();
    void held.opened.then(() => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(server.identity));
    });
  });
  openListeners.push(listener);
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
}

describe('a supervisor that shuts down', () => {
  test('an endpoint whose owned servers all release closes reporting a clean release', async () => {
    const rig = makeRig();
    const [idle] = await idleSlots(rig, [0]);
    const endpoint = await serveSupervisor(rig.supervisor, join(rig.okRoot, 'supervisor.sock'));
    openEndpoints.push(endpoint);

    await endpoint.close();

    expect(await endpoint.closed).toEqual({ released: true });
    expect(await serving(idle?.baseURL ?? '')).toBe(false);
  });

  test('an endpoint whose owned server fails to release closes reporting that failure, with a warning naming the slot', async () => {
    const reports = warnings();
    const rig = makeRig((launch) => releaseFailsAfterReleasing(launch));
    await idleSlots(rig, [0]);
    const endpoint = await serveSupervisor(rig.supervisor, join(rig.okRoot, 'supervisor.sock'));
    openEndpoints.push(endpoint);
    const operator = await connectLeaseClient(endpoint.socketPath, 5_000);

    await operator.shutdown(CALL_MS);
    operator.close();

    const failure = `releasing the owned servers failed: slot 0: ${RELEASE_FAILURE} for slot 0`;
    expect(await endpoint.closed).toEqual({ released: false, failure });
    expect(reports).toEqual([`[server reuse] ${failure}`]);
  });

  test('a shutdown whose two releases fail settles only after both have run, and reports each by slot', async () => {
    const slowRelease = gate();
    const rig = makeRig((launch) => releaseFailsAfterReleasing(launch, slowRelease));
    const idle = await idleSlots(rig, [0, 1]);

    const shutdown = rig.supervisor.shutdown();
    const shutdownSettled = settledFlag(shutdown);
    await slowRelease.reached;
    await afterPendingTurns();

    expect(shutdownSettled()).toBe(false);
    slowRelease.open();
    await expect(shutdown).rejects.toThrow(
      `releasing the owned servers failed: slot 0: ${RELEASE_FAILURE} for slot 0; slot 1: ${RELEASE_FAILURE} for slot 1`,
    );
    for (const { baseURL } of idle) expect(await serving(baseURL)).toBe(false);
  });

  test('an admission checking an idle slot when shutdown begins is refused and launches no new server', async () => {
    const heldIdentity = gate();
    let launches = 0;
    const rig = makeRig((launch) => async (slot, workerServerEnv) => {
      launches += 1;
      const owned = await launch(slot, workerServerEnv);
      return { ...owned, baseURL: await identityHeldBehind(heldIdentity, owned) };
    });
    const first = granted(await rig.supervisor.acquire(rig.request({ run: 'run-a' })));
    await rig.supervisor.release(first.token, false);
    const [firstServer] = rig.launcher.launched;
    if (firstServer === undefined) throw new Error('the first acquire launched no server');

    const admission = rig.supervisor.acquire(rig.request({ run: 'run-b' }));
    await heldIdentity.reached;
    const shutdown = rig.supervisor.shutdown();
    heldIdentity.open();

    expect(await admission).toEqual({
      kind: 'refused',
      reason: 'supervisor-closed',
      detail: 'the supervisor shut down while admission checked the slot',
    });
    await shutdown;
    expect(launches).toBe(1);
    expect(await serving(firstServer.baseURL)).toBe(false);
  });

  test('a shutdown that begins while a slot is starting its server settles only after that server is released', async () => {
    const heldLaunch = gate();
    const rig = makeRig((launch) => async (slot, workerServerEnv) => {
      heldLaunch.markReached();
      await heldLaunch.opened;
      return launch(slot, workerServerEnv);
    });

    const admission = rig.supervisor.acquire(rig.request({}));
    await heldLaunch.reached;
    const shutdown = rig.supervisor.shutdown();
    const shutdownSettled = settledFlag(shutdown);
    await afterPendingTurns();

    expect(shutdownSettled()).toBe(false);
    heldLaunch.open();
    await shutdown;
    const [lateServer] = rig.launcher.launched;
    if (lateServer === undefined) throw new Error('the held launch started no server');
    expect(await serving(lateServer.baseURL)).toBe(false);
    expect(await admission).toEqual({
      kind: 'refused',
      reason: 'supervisor-closed',
      detail: 'the supervisor shut down while the slot was starting',
    });
  });
});
