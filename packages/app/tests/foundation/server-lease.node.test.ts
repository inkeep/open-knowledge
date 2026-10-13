import { type ChildProcess, execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type {
  LeaseOutcome,
  LeaseRequest,
  WorkerServerEnv,
} from '../stress/_helpers/reuse/lease-protocol.ts';
import {
  type LaunchOwnedServer,
  WorkerServerSupervisor,
} from '../stress/_helpers/reuse/server-supervisor.ts';
import {
  connectLeaseClient,
  type LeaseClient,
  type SupervisorEndpoint,
  serveSupervisor,
} from '../stress/_helpers/reuse/supervisor-socket.ts';
import {
  contractServerLauncher,
  exitContractServer,
  forgeContractServerIdentity,
} from './contract-dev-server.test-helper.ts';

const STRESS_CONFIG = '/worktree/packages/app/playwright.config.ts#chromium';

interface Rig {
  readonly supervisor: WorkerServerSupervisor;
  readonly launcher: ReturnType<typeof contractServerLauncher>;
  readonly okRoot: string;
  readonly releaseFailure: string | undefined;
  request(overrides: Partial<LeaseRequest>): LeaseRequest;
}

interface RigOptions {
  readonly launch?: (launch: LaunchOwnedServer) => LaunchOwnedServer;
  readonly releaseFailure?: string;
}

const openRigs: Rig[] = [];
const openListeners: Server[] = [];
const openEndpoints: SupervisorEndpoint[] = [];
const openClients: LeaseClient[] = [];
const openScratch: string[] = [];

function makeRig({ launch, releaseFailure }: RigOptions = {}): Rig {
  const okRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lease-root-')));
  mkdirSync(join(okRoot, 'packages', 'server', 'src'), { recursive: true });
  mkdirSync(join(okRoot, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(okRoot, 'packages', 'server', 'src', 'boot.ts'), 'export const boot = 1;\n');
  writeFileSync(join(okRoot, 'packages', 'app', 'src', 'App.tsx'), 'export const app = 1;\n');
  const launcher = contractServerLauncher();
  const supervisor = new WorkerServerSupervisor({
    okRoot,
    launch: launch === undefined ? launcher.launch : launch(launcher.launch),
    identityTimeoutMs: 2_000,
  });
  const rig: Rig = {
    supervisor,
    launcher,
    okRoot,
    releaseFailure,
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

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  for (const endpoint of openEndpoints.splice(0)) await endpoint.close();
  for (const listener of openListeners.splice(0)) {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  for (const rig of openRigs.splice(0)) {
    await rig.supervisor.shutdown().catch((error: unknown) => {
      if (rig.releaseFailure === undefined || !String(error).includes(rig.releaseFailure)) {
        throw error;
      }
    });
    rmSync(rig.okRoot, { recursive: true, force: true });
  }
  for (const dir of openScratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function granted(outcome: LeaseOutcome): Extract<LeaseOutcome, { kind: 'granted' }> {
  if (outcome.kind !== 'granted') {
    throw new Error(`expected a granted lease, got ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome;
}

function refusal(outcome: LeaseOutcome): Extract<LeaseOutcome, { kind: 'refused' }> {
  if (outcome.kind !== 'refused')
    throw new Error(`expected a refusal, got a lease on ${outcome.baseURL}`);
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

function processExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => proc.once('exit', () => resolve()));
}

async function occupyWithForgedIdentity(
  port: number,
  identity: unknown,
): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  const listener = createServer((request: IncomingMessage, response) => {
    requests.push(request.url ?? '');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(identity));
  });
  openListeners.push(listener);
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', () => resolve());
  });
  expect((listener.address() as AddressInfo).port).toBe(port);
  return { requests };
}

async function identityNonce(baseURL: string): Promise<unknown> {
  const response = await fetch(`${baseURL}/__ok-test-server-identity`);
  return ((await response.json()) as { nonce?: unknown }).nonce;
}

describe('worker server leases', () => {
  test('a slot launched for one run is leased to the next run without a second launch', async () => {
    const rig = makeRig();
    const first = granted(await rig.supervisor.acquire(rig.request({ run: 'run-a' })));
    expect(first.launched).toBe(true);
    const firstNonce = await identityNonce(first.baseURL);
    await rig.supervisor.release(first.token, false);

    const second = granted(await rig.supervisor.acquire(rig.request({ run: 'run-b' })));
    expect(second.launched).toBe(false);
    expect(second.relaunchedBecause).toBeNull();
    expect(second.baseURL).toBe(first.baseURL);
    expect(second.contentDir).toBe(first.contentDir);
    expect(await identityNonce(second.baseURL)).toBe(firstNonce);
    expect(rig.launcher.launched).toHaveLength(1);
  });

  test('an overlapping run asking for a held slot is refused as busy and the holder keeps its server', async () => {
    const rig = makeRig();
    const held = granted(await rig.supervisor.acquire(rig.request({ run: 'run-a' })));
    const nonce = await identityNonce(held.baseURL);

    const overlapping = refusal(await rig.supervisor.acquire(rig.request({ run: 'run-b' })));
    expect(overlapping.reason).toBe('busy');
    expect(overlapping.detail).toContain('run-a');
    expect(await rig.supervisor.verify(held.token)).toEqual({ held: true });
    expect(await identityNonce(held.baseURL)).toBe(nonce);
    expect(rig.launcher.launched).toHaveLength(1);
  });

  test('overlapping workers of one run lease distinct slots with their own servers and content roots', async () => {
    const rig = makeRig();
    const [zero, one] = await Promise.all([
      rig.supervisor.acquire(rig.request({ slot: 0 })),
      rig.supervisor.acquire(rig.request({ slot: 1 })),
    ]);
    const first = granted(zero);
    const second = granted(one);
    expect(second.baseURL).not.toBe(first.baseURL);
    expect(second.contentDir).not.toBe(first.contentDir);
    expect(await identityNonce(second.baseURL)).not.toBe(await identityNonce(first.baseURL));
    expect(rig.launcher.launched).toHaveLength(2);
  });

  test('a run whose worker environment differs restarts the idle slot with that environment', async () => {
    const rig = makeRig();
    const env: WorkerServerEnv = { OK_TEST_FEATURE: 'on' };
    const first = granted(await rig.supervisor.acquire(rig.request({ workerServerEnv: env })));
    await rig.supervisor.release(first.token, false);

    const changed: WorkerServerEnv = { OK_TEST_FEATURE: 'off' };
    const differing = granted(
      await rig.supervisor.acquire(rig.request({ run: 'run-b', workerServerEnv: changed })),
    );
    expect(differing.launched).toBe(true);
    expect(differing.relaunchedBecause).toBe('its workerServerEnv differs in OK_TEST_FEATURE');
    expect(differing.baseURL).not.toBe(first.baseURL);
    expect(await serving(first.baseURL)).toBe(false);
    await rig.supervisor.release(differing.token, false);

    const same = granted(
      await rig.supervisor.acquire(rig.request({ run: 'run-c', workerServerEnv: changed })),
    );
    expect(same.launched).toBe(false);
    expect(same.baseURL).toBe(differing.baseURL);
    expect(rig.launcher.environments).toEqual([env, changed]);
  });

  test('a run from another invocation config is refused as incompatible', async () => {
    const rig = makeRig();
    const first = granted(await rig.supervisor.acquire(rig.request({})));
    await rig.supervisor.release(first.token, false);

    const other = refusal(
      await rig.supervisor.acquire(
        rig.request({
          run: 'run-b',
          config: '/worktree/packages/app/playwright.a11y.config.ts#a11y',
        }),
      ),
    );
    expect(other.reason).toBe('incompatible');
    expect(other.detail).toContain('invocation config');
    expect(rig.launcher.launched).toHaveLength(1);
  });

  test('an admission whose discard of the previous server fails is refused with that failure and leaves the slot unleased', async () => {
    const rig = makeRig({ launch: failingRelease, releaseFailure: RELEASE_FAILURE });
    const first = granted(
      await rig.supervisor.acquire(rig.request({ workerServerEnv: { OK_TEST_FEATURE: 'on' } })),
    );
    await rig.supervisor.release(first.token, false);

    const failed = refusal(
      await rig.supervisor.acquire(
        rig.request({ run: 'run-b', workerServerEnv: { OK_TEST_FEATURE: 'off' } }),
      ),
    );
    expect(failed.reason).toBe('launch-failed');
    expect(failed.detail).toContain(RELEASE_FAILURE);
    expect(slotStatus(rig, 0)?.leasedBy).toBeNull();

    const next = granted(
      await rig.supervisor.acquire(
        rig.request({ run: 'run-c', workerServerEnv: { OK_TEST_FEATURE: 'off' } }),
      ),
    );
    expect(next.launched).toBe(true);
  });

  test('an admission whose reuse check throws is refused with that error and leaves the slot unleased', async () => {
    const rig = makeRig();
    const first = granted(await rig.supervisor.acquire(rig.request({})));
    await rig.supervisor.release(first.token, false);
    const dangling = join(rig.okRoot, 'packages', 'server', 'src', 'dangling.ts');
    symlinkSync(join(rig.okRoot, 'missing.ts'), dangling);

    const failed = refusal(await rig.supervisor.acquire(rig.request({ run: 'run-b' })));
    expect(failed.reason).toBe('launch-failed');
    expect(failed.detail).toContain('ENOENT');
    expect(slotStatus(rig, 0)?.leasedBy).toBeNull();

    rmSync(dangling);
    const next = granted(await rig.supervisor.acquire(rig.request({ run: 'run-c' })));
    expect(next.launched).toBe(false);
    expect(next.baseURL).toBe(first.baseURL);
  });

  test('a run from another worktree is refused before an empty slot launches a server from this one', async () => {
    const rig = makeRig();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lease-other-worktree-')));
    openScratch.push(elsewhere);

    const other = refusal(await rig.supervisor.acquire(rig.request({ worktree: elsewhere })));
    expect(other.reason).toBe('incompatible');
    expect(other.detail).toBe(
      `worktree ${elsewhere} is not this supervisor's worktree ${rig.okRoot}; it would test that checkout's code`,
    );
    expect(rig.launcher.launched).toHaveLength(0);

    const own = granted(await rig.supervisor.acquire(rig.request({})));
    expect(own.launched).toBe(true);
  });

  test('a server that exits after its receipt during a lease loses the lease and aborts that run', async () => {
    const rig = makeRig();
    const held = granted(await rig.supervisor.acquire(rig.request({ run: 'run-a' })));
    const [server] = rig.launcher.launched;
    if (server === undefined) throw new Error('no server was launched');
    await exitContractServer(server);

    const verdict = await rig.supervisor.verify(held.token);
    expect(verdict.held).toBe(false);
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('exited with code 0 during the lease'),
    });
    const again = refusal(await rig.supervisor.acquire(rig.request({ run: 'run-a', slot: 1 })));
    expect(again.reason).toBe('run-aborted');

    await rig.supervisor.release(held.token, false);
    const next = granted(await rig.supervisor.acquire(rig.request({ run: 'run-b' })));
    expect(next.launched).toBe(true);
    expect(next.baseURL).not.toBe(held.baseURL);
    expect(rig.launcher.launched).toHaveLength(2);
  });

  test('a server whose lifetime owner is lost during a lease loses the lease and aborts that run', async () => {
    const rig = makeRig();
    const held = granted(await rig.supervisor.acquire(rig.request({ run: 'run-a' })));
    const [server] = rig.launcher.launched;
    if (server === undefined) throw new Error('no server was launched');
    const ownerLost = new Error(
      'worker server lifetime closed without completed release (code=1, signal=null)',
    );

    expect(() => server.proc.emit('error', ownerLost)).not.toThrow();

    expect(await rig.supervisor.verify(held.token)).toEqual({
      held: false,
      reason: `its server lifetime failed during the lease: ${ownerLost.message}`,
    });
    await processExit(server.proc);
    expect(
      refusal(await rig.supervisor.acquire(rig.request({ run: 'run-a', slot: 1 }))).reason,
    ).toBe('run-aborted');
  });

  test('an idle slot whose lifetime owner is lost is discarded and relaunched for the next run', async () => {
    const rig = makeRig();
    const first = granted(await rig.supervisor.acquire(rig.request({ run: 'run-a' })));
    await rig.supervisor.release(first.token, false);
    const [server] = rig.launcher.launched;
    if (server === undefined) throw new Error('no server was launched');
    const ownerLost = new Error('write EPIPE');

    expect(() => server.proc.emit('error', ownerLost)).not.toThrow();

    const next = granted(await rig.supervisor.acquire(rig.request({ run: 'run-b' })));
    expect(next.launched).toBe(true);
    expect(next.relaunchedBecause).toBe(`its server lifetime failed: ${ownerLost.message}`);
    await processExit(server.proc);
  });

  test("a foreign listener answering an exited slot server's old identity on its port is never attached", async () => {
    const rig = makeRig();
    const first = granted(await rig.supervisor.acquire(rig.request({})));
    await rig.supervisor.release(first.token, false);
    const [server] = rig.launcher.launched;
    if (server === undefined) throw new Error('no server was launched');
    await exitContractServer(server);
    const foreign = await occupyWithForgedIdentity(first.port, server.identity);

    const next = granted(await rig.supervisor.acquire(rig.request({ run: 'run-b' })));
    expect(next.launched).toBe(true);
    expect(next.relaunchedBecause).toContain('exited with code 0');
    expect(next.baseURL).not.toBe(first.baseURL);
    expect(foreign.requests).toEqual([]);
  });

  test('a server whose identity changes during a lease loses the lease, aborts the run and is released', async () => {
    const rig = makeRig();
    const held = granted(await rig.supervisor.acquire(rig.request({ run: 'run-a' })));
    const [server] = rig.launcher.launched;
    if (server === undefined) throw new Error('no server was launched');
    await forgeContractServerIdentity(server);

    const verdict = await rig.supervisor.verify(held.token);
    expect(verdict).toEqual({
      held: false,
      reason:
        'its server identity changed during the lease: its identity endpoint answers for a different server',
    });
    expect(server.proc.exitCode !== null || server.proc.signalCode !== null).toBe(true);
    expect(await serving(held.baseURL)).toBe(false);
    expect(existsSync(held.contentDir)).toBe(false);
    expect(refusal(await rig.supervisor.acquire(rig.request({ run: 'run-a' }))).reason).toBe(
      'run-aborted',
    );
  });

  test('a server or core edit relaunches the slot while an app-only edit keeps it', async () => {
    const rig = makeRig();
    const first = granted(await rig.supervisor.acquire(rig.request({})));
    await rig.supervisor.release(first.token, false);
    writeFileSync(join(rig.okRoot, 'packages', 'app', 'src', 'App.tsx'), 'export const app = 2;\n');
    const appEdit = granted(await rig.supervisor.acquire(rig.request({ run: 'run-b' })));
    expect(appEdit.launched).toBe(false);
    await rig.supervisor.release(appEdit.token, false);

    writeFileSync(
      join(rig.okRoot, 'packages', 'server', 'src', 'boot.ts'),
      'export const boot = 2;\n',
    );
    const serverEdit = granted(await rig.supervisor.acquire(rig.request({ run: 'run-c' })));
    expect(serverEdit.launched).toBe(true);
    expect(serverEdit.relaunchedBecause).toBe(
      'its consumed inputs changed: packages/server/src/boot.ts',
    );
    expect(await serving(first.baseURL)).toBe(false);
  });

  test('a slot whose content root disappeared is relaunched with a new one', async () => {
    const rig = makeRig();
    const first = granted(await rig.supervisor.acquire(rig.request({})));
    await rig.supervisor.release(first.token, false);
    rmSync(first.contentDir, { recursive: true, force: true });

    const next = granted(await rig.supervisor.acquire(rig.request({ run: 'run-b' })));
    expect(next.launched).toBe(true);
    expect(next.relaunchedBecause).toBe(`its content root ${first.contentDir} is gone`);
    expect(existsSync(next.contentDir)).toBe(true);
  });

  test('shutdown aborts the holding run, releases every owned server and refuses new leases', async () => {
    const rig = makeRig();
    const held = granted(await rig.supervisor.acquire(rig.request({ slot: 0 })));
    const idle = granted(await rig.supervisor.acquire(rig.request({ slot: 1 })));
    await rig.supervisor.release(idle.token, false);

    await rig.supervisor.shutdown();
    expect(await serving(held.baseURL)).toBe(false);
    expect(await serving(idle.baseURL)).toBe(false);
    expect(existsSync(held.contentDir)).toBe(false);
    expect(existsSync(idle.contentDir)).toBe(false);
    expect(await rig.supervisor.verify(held.token)).toEqual({
      held: false,
      reason: 'the supervisor shut down during the lease',
    });
    expect(refusal(await rig.supervisor.acquire(rig.request({ run: 'run-b' }))).reason).toBe(
      'supervisor-closed',
    );
  });
});

const CALL_MS = 30_000;

async function servedRig(
  options: RigOptions = {},
): Promise<{ rig: Rig; endpoint: SupervisorEndpoint }> {
  const rig = makeRig(options);
  const endpoint = await serveSupervisor(rig.supervisor, join(rig.okRoot, 'supervisor.sock'));
  openEndpoints.push(endpoint);
  return { rig, endpoint };
}

async function client(endpoint: SupervisorEndpoint): Promise<LeaseClient> {
  const connected = await connectLeaseClient(endpoint.socketPath, 5_000);
  openClients.push(connected);
  return connected;
}

const RELEASE_FAILURE = 'the server stopped, but its release reported a failure';
const SETTLE_MS = 10_000;

function failingRelease(launch: LaunchOwnedServer): LaunchOwnedServer {
  return async (slot, workerServerEnv) => {
    const owned = await launch(slot, workerServerEnv);
    return {
      ...owned,
      release: async () => {
        await owned.release();
        throw new Error(RELEASE_FAILURE);
      },
    };
  };
}

interface HeldLaunch {
  readonly started: Promise<void>;
  proceed(): void;
  wrap(launch: LaunchOwnedServer): LaunchOwnedServer;
}

function holdLaunch(heldSlot: number): HeldLaunch {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let proceed: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  return {
    started,
    proceed: () => proceed(),
    wrap: (launch) => async (slot, workerServerEnv) => {
      if (slot === heldSlot) {
        markStarted();
        await gate;
      }
      return launch(slot, workerServerEnv);
    },
  };
}

function slotStatus(rig: Rig, slot: number) {
  return rig.supervisor.status().find((entry) => entry.slot === slot);
}

function discardReports(): string[] {
  const reports: string[] = [];
  const passThrough = console.warn.bind(console);
  const warn = vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
    const line = parts.map(String).join(' ');
    if (line.includes('discarding the server')) reports.push(line);
    else passThrough(...parts);
  });
  onTestFinished(() => warn.mockRestore());
  return reports;
}

async function closeWhileSlotZeroLaunches(
  rig: Rig,
  endpoint: SupervisorEndpoint,
  held: HeldLaunch,
): Promise<string> {
  const holder = await client(endpoint);
  granted(await holder.acquire(rig.request({ slot: 1 }), CALL_MS));
  const late = holder.acquire(rig.request({ slot: 0 }), CALL_MS).then(
    () => 'answered',
    (error: unknown) => String(error),
  );
  await held.started;
  holder.close();
  await expect.poll(() => slotStatus(rig, 1)?.leasedBy, { timeout: SETTLE_MS }).toBeNull();
  held.proceed();
  return late;
}

function rawExchange(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let received = '';
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (received.includes('\n')) {
        socket.destroy();
        resolve(received.trim());
      }
    });
    socket.once('connect', () => socket.write(`${line}\n`));
  });
}

describe('worker server leases over the supervisor socket', () => {
  test('a lease whose holding connection closes without releasing it is freed and its server discarded, so the next run starts a new one', async () => {
    const { rig, endpoint } = await servedRig();
    const first = await client(endpoint);
    const held = granted(await first.acquire(rig.request({ run: 'run-a' }), CALL_MS));
    const heldNonce = await identityNonce(held.baseURL);
    const second = await client(endpoint);
    expect(refusal(await second.acquire(rig.request({ run: 'run-b' }), CALL_MS)).reason).toBe(
      'busy',
    );

    first.close();
    await expect.poll(() => rig.supervisor.status()[0]?.leasedBy).toBeNull();
    const relaunched = granted(await second.acquire(rig.request({ run: 'run-b' }), CALL_MS));
    expect(relaunched.launched).toBe(true);
    expect(relaunched.relaunchedBecause).toBe('its holder disconnected without releasing it');
    expect(rig.launcher.launched).toHaveLength(2);
    expect(await identityNonce(relaunched.baseURL)).not.toBe(heldNonce);
  });

  test('an acquire answered after its connection closed leaves the slot unleased and discards the server it launched', async () => {
    const held = holdLaunch(0);
    const { rig, endpoint } = await servedRig({ launch: held.wrap });

    expect(await closeWhileSlotZeroLaunches(rig, endpoint, held)).toContain(
      'closed the lease connection',
    );
    await expect.poll(() => slotStatus(rig, 0)?.leasedBy, { timeout: SETTLE_MS }).toBeNull();
    expect(rig.supervisor.status()).toEqual([
      { slot: 0, baseURL: null, config: null, leasedBy: null },
      { slot: 1, baseURL: null, config: null, leasedBy: null },
    ]);
    const [, lateServer] = rig.launcher.launched;
    if (lateServer === undefined) throw new Error('the acquire for slot 0 launched no server');
    await expect.poll(() => serving(lateServer.baseURL), { timeout: SETTLE_MS }).toBe(false);

    const next = await client(endpoint);
    const relaunched = granted(await next.acquire(rig.request({ run: 'run-b' }), CALL_MS));
    expect(relaunched.launched).toBe(true);
    expect(relaunched.relaunchedBecause).toBe('its holder disconnected without releasing it');
  });

  test('a failed discard after a lease connection closes is reported with its slot and run, whether the lease was held or granted after the close', async () => {
    const reports = discardReports();
    const held = holdLaunch(0);
    const { rig, endpoint } = await servedRig({
      launch: (launch) => held.wrap(failingRelease(launch)),
      releaseFailure: RELEASE_FAILURE,
    });

    await closeWhileSlotZeroLaunches(rig, endpoint, held);
    await expect.poll(() => reports.length, { timeout: SETTLE_MS }).toBe(2);
    expect([...reports].sort()).toEqual([
      `[server reuse] slot 0: discarding the server of run run-a, whose lease connection closed without a release, failed: ${RELEASE_FAILURE}`,
      `[server reuse] slot 1: discarding the server of run run-a, whose lease connection closed without a release, failed: ${RELEASE_FAILURE}`,
    ]);
  });

  test('only the connection holding a lease can verify or release it', async () => {
    const { rig, endpoint } = await servedRig();
    const holder = await client(endpoint);
    const held = granted(await holder.acquire(rig.request({}), CALL_MS));
    const stranger = await client(endpoint);

    expect(await stranger.verify(held.token, CALL_MS)).toEqual({
      held: false,
      reason: 'the lease is not held by this connection',
    });
    await stranger.release(held.token, true, CALL_MS);
    expect(await holder.verify(held.token, CALL_MS)).toEqual({ held: true });
    expect(rig.supervisor.status()[0]?.leasedBy).toBe('run-a');
  });

  test('a malformed request is answered with an error and grants no lease', async () => {
    const { rig, endpoint } = await servedRig();
    const answer = JSON.parse(
      await rawExchange(
        endpoint.socketPath,
        JSON.stringify({ id: 4, op: 'acquire', request: { ...rig.request({}), slot: -1 } }),
      ),
    ) as { ok: boolean; error: string };
    expect(answer).toEqual({
      id: 0,
      ok: false,
      error: 'malformed request: lease request.slot is not a non-negative integer',
    });
    expect(rig.supervisor.status()).toEqual([]);
    expect(rig.launcher.launched).toHaveLength(0);
  });

  test('a socket already served by a live supervisor is refused and a stale socket file is reclaimed', async () => {
    const { rig, endpoint } = await servedRig();
    const rival = new WorkerServerSupervisor({
      okRoot: rig.okRoot,
      launch: rig.launcher.launch,
      identityTimeoutMs: 2_000,
    });
    await expect(serveSupervisor(rival, endpoint.socketPath)).rejects.toThrow(
      `another supervisor already serves ${endpoint.socketPath}`,
    );
    expect(await (await client(endpoint)).status(CALL_MS)).toEqual([]);

    const stale = join(rig.okRoot, 'stale.sock');
    execFileSync(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(stale)}, () => process.exit(0))`,
    ]);
    expect(existsSync(stale)).toBe(true);
    const reclaimed = await serveSupervisor(rival, stale);
    openEndpoints.push(reclaimed);
    expect(await (await client(reclaimed)).status(CALL_MS)).toEqual([]);
  });

  test('an entry at the socket path that is not a socket is refused by its kind and left in place', async () => {
    const rig = makeRig();
    const rival = new WorkerServerSupervisor({
      okRoot: rig.okRoot,
      launch: rig.launcher.launch,
      identityTimeoutMs: 2_000,
    });
    const regular = join(rig.okRoot, 'regular.sock');
    writeFileSync(regular, 'a regular file\n');
    const directory = join(rig.okRoot, 'directory.sock');
    mkdirSync(directory);
    const target = join(rig.okRoot, 'link-target.txt');
    writeFileSync(target, 'the link target\n');
    const link = join(rig.okRoot, 'link.sock');
    symlinkSync(target, link);
    const inodes = [regular, directory, link].map((path) => lstatSync(path).ino);

    await expect(serveSupervisor(rival, regular)).rejects.toThrow(
      `cannot claim ${regular}: it is a regular file, not a socket`,
    );
    await expect(serveSupervisor(rival, directory)).rejects.toThrow(
      `cannot claim ${directory}: it is a directory, not a socket`,
    );
    await expect(serveSupervisor(rival, link)).rejects.toThrow(
      `cannot claim ${link}: it is a symbolic link, not a socket`,
    );

    expect(readFileSync(regular, 'utf8')).toBe('a regular file\n');
    expect(lstatSync(directory).isDirectory()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('the link target\n');
    expect([regular, directory, link].map((path) => lstatSync(path).ino)).toEqual(inodes);
  });

  test('a shutdown request answers, closes the endpoint and releases every owned server', async () => {
    const { rig, endpoint } = await servedRig();
    const holder = await client(endpoint);
    const held = granted(await holder.acquire(rig.request({}), CALL_MS));

    await holder.shutdown(CALL_MS);
    await endpoint.closed;
    expect(await serving(held.baseURL)).toBe(false);
    expect(existsSync(held.contentDir)).toBe(false);
    await expect(connectLeaseClient(endpoint.socketPath, 2_000)).rejects.toThrow(
      'is not reachable',
    );
  });
});
