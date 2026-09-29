import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { errors } from '@playwright/test';
import { type CallExpression, type Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getFreePort } from '../free-port.test-helper.ts';
import {
  checkCollabSync,
  requireBoundMs,
  rollbackPreparedViteCacheDir,
  waitForHttpReady,
} from '../stress/_helpers/server-process.ts';

const FIXTURE_MODULE = '../stress/_helpers/fixtures.ts';

const DECLARED_TOTAL_EXPORT = 'WORKER_SERVER_BUDGET_TOTAL_MS';
const DECLARED_RESERVES_EXPORT = 'WORKER_SERVER_BUDGET_RESERVES';
const RESOLVE_READINESS_EXPORT = 'resolveReadinessBudgetMs';
const RESOLVE_FIRST_LOAD_STALL_EXPORT = 'resolveFirstLoadStallMs';
const IS_RESERVE_TABLE_EXPORT = 'isReserveTable';
const TEARDOWN_RESERVE_KEY = 'teardown';
const SETUP_OVERHEAD_RESERVE_KEY = 'setupOverhead';

const LOOPBACK = '127.0.0.1';
const PROJECT_TIMEOUT_MS = 120_000;

const ADMISSION_TOTAL_MS = 10_000;
const ADMISSION_RESERVES = {
  apiConfig: 400,
  collabSync: 400,
  warmupGoto: 800,
  warmupVisible: 800,
  [TEARDOWN_RESERVE_KEY]: 1_600,
} as const;
const UNDERIVED_READINESS_MS = 1_200;
const SERVER_BINDS_AFTER_MS = 2_400;

const RESERVE_TOTAL_MS = 6_000;
const RESERVE_SETUP_SHARES = {
  apiConfig: 300,
  collabSync: 300,
  warmupGoto: 600,
  warmupVisible: 600,
} as const;
const RESERVE_TEARDOWN_MS = 2_200;
const RESERVE_TEARDOWN_NEED_SHARE = 4;

const SHARED_SLOT_TOTAL_MS = 4_000;
const SHARED_SLOT_GREEDY_SETUP_MS = 3_000;
const SHARED_SLOT_FRUGAL_SETUP_MS = 200;
const SHARED_SLOT_TEARDOWN_NEED_MS = 1_500;

const NEVER_READY_SHARE_MS = 1_200;
const GUARD_TOTAL_MS = 8_000;
const GENEROUS_READINESS_SHARE_MS = 30_000;
const SLOT_SHAPE_PROBE_TOTAL_MS = 2_000;

const STUB_READY_MARKER = 'stub-dev-command-ready';
const ANNOUNCE_STUB_READY = `process.stdout.write("${STUB_READY_MARKER}\\n");`;

const STUBBORN_DEV_COMMAND = `process.on("SIGTERM", () => {}); ${ANNOUNCE_STUB_READY} setTimeout(() => process.exit(0), 30000);`;
const REAPED_ON_SIGTERM_DEV_COMMAND = `process.on("SIGTERM", () => process.exit(0)); ${ANNOUNCE_STUB_READY} setTimeout(() => process.exit(0), 30000);`;
const LONG_LIVED_DEV_COMMAND = 'setTimeout(() => process.exit(0), 30000);';
const IMMEDIATELY_EXITING_DEV_COMMAND = 'process.exit(7)';

type ReserveTable = Readonly<Record<string, number>>;
type ResolveReadiness = (totalMs: number, reserves: ReserveTable) => number;

interface FixtureSlot {
  timeout: number;
  elapsed: number;
}

interface FixtureInstance {
  _setupDescription: { slot?: FixtureSlot };
}

interface PlaywrightFixtureRunner {
  workerFixtureTimeout: number;
  instanceForId: Map<string, FixtureInstance>;
  _setupFixtureForRegistration(
    registration: unknown,
    testInfo: unknown,
    runnable: unknown,
  ): Promise<FixtureInstance>;
  teardownScope(scope: string, testInfo: unknown, runnable: unknown): Promise<void>;
}

interface PlaywrightTimeoutManager {
  withRunnable(runnable: unknown, run: () => Promise<void>): Promise<void>;
}

interface WorkerInternals {
  version: string;
  FixtureRunner: new () => PlaywrightFixtureRunner;
  TimeoutManager: new (defaultTimeoutMs: number) => PlaywrightTimeoutManager;
  TimeoutManagerError: new (...args: never[]) => Error;
}

// UPSTREAM(@playwright/test@1.59.1): a worker fixture's setup and teardown draw down one shared slot object
const PLAYWRIGHT_WORKER_INTERNALS_VERIFIED_AT = '1.59.1';

const FIXTURE_RUNNER_MODULE = 'playwright/lib/worker/fixtureRunner.js';
const TIMEOUT_MANAGER_MODULE = 'playwright/lib/worker/timeoutManager.js';

const FIXTURE_RUNNER_MEMBERS = [
  'instanceForId',
  'workerFixtureTimeout',
  '_setupFixtureForRegistration',
  'teardownScope',
] as const;

const FIXTURE_INSTANCE_SLOT_MEMBER = '_setupDescription';

const WORKER_INTERNALS_EXPECTED: readonly string[] = [
  ...FIXTURE_RUNNER_MEMBERS.map((member) => `FixtureRunner#${member}`),
  'FixtureRunner#instanceForId is a Map',
  'TimeoutManager#withRunnable',
  'TimeoutManagerError',
  `FixtureInstance#${FIXTURE_INSTANCE_SLOT_MEMBER}.slot.{timeout,elapsed}`,
];

const FIXTURE_SLOT_MEMBERS = ['timeout', 'elapsed'] as const;

function missingFixtureSlotMembers(instance: FixtureInstance | undefined): string[] {
  const slotPath = `FixtureInstance#${FIXTURE_INSTANCE_SLOT_MEMBER}.slot`;
  if (instance === undefined || !(FIXTURE_INSTANCE_SLOT_MEMBER in instance)) {
    return [`FixtureInstance#${FIXTURE_INSTANCE_SLOT_MEMBER}`];
  }
  const slot = instance._setupDescription.slot as unknown;
  if (typeof slot !== 'object' || slot === null) return [slotPath];
  return FIXTURE_SLOT_MEMBERS.filter(
    (member) => !Number.isFinite((slot as Record<string, unknown>)[member]),
  ).map((member) => `${slotPath}.${member}`);
}

function missingWorkerInternalsMembers(
  fixtureRunnerModule: unknown,
  timeoutManagerModule: unknown,
): string[] {
  const missing: string[] = [];
  const runnerExport = (fixtureRunnerModule as { FixtureRunner?: unknown } | null | undefined)
    ?.FixtureRunner;
  if (typeof runnerExport !== 'function') {
    missing.push('FixtureRunner');
  } else {
    let probe: Record<string, unknown> | undefined;
    try {
      probe = new (runnerExport as new () => Record<string, unknown>)();
    } catch {
      missing.push('FixtureRunner (no longer constructible with no arguments)');
    }
    if (probe !== undefined) {
      for (const member of FIXTURE_RUNNER_MEMBERS) {
        if (!(member in probe)) missing.push(`FixtureRunner#${member}`);
      }
      if ('instanceForId' in probe && !(probe.instanceForId instanceof Map)) {
        missing.push('FixtureRunner#instanceForId is a Map');
      }
    }
  }

  const timeoutExports = timeoutManagerModule as
    | { TimeoutManager?: unknown; TimeoutManagerError?: unknown }
    | null
    | undefined;
  const managerExport = timeoutExports?.TimeoutManager;
  if (typeof managerExport !== 'function') {
    missing.push('TimeoutManager');
  } else if (!('withRunnable' in (managerExport as { prototype: object }).prototype)) {
    missing.push('TimeoutManager#withRunnable');
  }
  if (typeof timeoutExports?.TimeoutManagerError !== 'function')
    missing.push('TimeoutManagerError');

  return missing;
}

function meetsVersionFloor(actual: string, floor: string): boolean {
  const partsOf = (version: string): number[] =>
    (version.split('-')[0] ?? version).split('.').map((part) => Number.parseInt(part, 10));
  const found = partsOf(actual);
  const required = partsOf(floor);
  const partAt = (parts: readonly number[], index: number): number =>
    index < parts.length ? Number(parts[index]) : 0;
  for (let index = 0; index < 3; index += 1) {
    const foundPart = partAt(found, index);
    const requiredPart = partAt(required, index);
    if (foundPart !== requiredPart) return foundPart > requiredPart;
  }
  return true;
}

function workerInternalsCouplingMessage(version: string, broken: readonly string[]): string {
  return [
    `these budget tests drive Playwright's worker internals directly: ${FIXTURE_RUNNER_MODULE} and ${TIMEOUT_MANAGER_MODULE}, neither of which the playwright package lists in its exports map.`,
    `The resolved playwright@${version} no longer supplies ${broken.join(', ')}.`,
    `The coupling expects ${WORKER_INTERNALS_EXPECTED.join(', ')}, verified against playwright@${PLAYWRIGHT_WORKER_INTERNALS_VERIFIED_AT}.`,
    'Re-verify the driver against this release and move that pin forward, or replace the driver.',
  ].join(' ');
}

function resolvedPackageVersion(packageJsonPath: string): string {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error(`${packageJsonPath} declares no version string`);
  }
  return parsed.version;
}

let cachedInternals: WorkerInternals | undefined;

function workerInternals(): WorkerInternals {
  if (cachedInternals !== undefined) return cachedInternals;
  const fromHere = createRequire(import.meta.url);
  const fromPlaywrightTest = createRequire(fromHere.resolve('@playwright/test'));
  const playwrightPackageJson = fromPlaywrightTest.resolve('playwright/package.json');
  const version = resolvedPackageVersion(playwrightPackageJson);
  if (!meetsVersionFloor(version, PLAYWRIGHT_WORKER_INTERNALS_VERIFIED_AT)) {
    throw new Error(
      workerInternalsCouplingMessage(version, [
        `a release below the verified ${PLAYWRIGHT_WORKER_INTERNALS_VERIFIED_AT}`,
      ]),
    );
  }
  const fromPlaywrightLib = createRequire(join(dirname(playwrightPackageJson), 'lib', 'index.js'));

  let fixtureRunnerModule: unknown;
  let timeoutManagerModule: unknown;
  try {
    fixtureRunnerModule = fromPlaywrightLib('./worker/fixtureRunner.js');
    timeoutManagerModule = fromPlaywrightLib('./worker/timeoutManager.js');
  } catch (err) {
    throw new Error(workerInternalsCouplingMessage(version, ['either module at its pinned path']), {
      cause: err,
    });
  }

  const missing = missingWorkerInternalsMembers(fixtureRunnerModule, timeoutManagerModule);
  if (missing.length > 0) throw new Error(workerInternalsCouplingMessage(version, missing));

  const { FixtureRunner } = fixtureRunnerModule as Pick<WorkerInternals, 'FixtureRunner'>;
  const { TimeoutManager, TimeoutManagerError } = timeoutManagerModule as Pick<
    WorkerInternals,
    'TimeoutManager' | 'TimeoutManagerError'
  >;
  cachedInternals = { version, FixtureRunner, TimeoutManager, TimeoutManagerError };
  return cachedInternals;
}

let cachedFixtureExports: Record<string, unknown> | undefined;

async function fixtureExports(): Promise<Record<string, unknown>> {
  cachedFixtureExports ??= (await import(FIXTURE_MODULE)) as unknown as Record<string, unknown>;
  return cachedFixtureExports;
}

async function declaredReserveTablePredicate(): Promise<(value: unknown) => boolean> {
  const predicate = (await fixtureExports())[IS_RESERVE_TABLE_EXPORT];
  expect(
    typeof predicate,
    `${FIXTURE_MODULE} must export ${IS_RESERVE_TABLE_EXPORT}, the one predicate both it and this suite judge a reserve table by`,
  ).toBe('function');
  return predicate as (value: unknown) => boolean;
}

async function expectDeclaredReserveTable(value: unknown): Promise<ReserveTable> {
  const isReserveTable = await declaredReserveTablePredicate();
  expect(
    isReserveTable(value),
    `${FIXTURE_MODULE} must export ${DECLARED_RESERVES_EXPORT} as positive per-phase reserves`,
  ).toBe(true);
  return value as ReserveTable;
}

function sumReserves(reserves: ReserveTable): number {
  return Object.values(reserves).reduce((total, ms) => total + ms, 0);
}

async function declaredTotalMs(): Promise<unknown> {
  return (await fixtureExports())[DECLARED_TOTAL_EXPORT];
}

async function declaredReserves(): Promise<unknown> {
  return (await fixtureExports())[DECLARED_RESERVES_EXPORT];
}

async function declaredResolveReadiness(): Promise<unknown> {
  return (await fixtureExports())[RESOLVE_READINESS_EXPORT];
}

function asResolveReadiness(candidate: unknown): ResolveReadiness {
  expect(typeof candidate, `${FIXTURE_MODULE} must export ${RESOLVE_READINESS_EXPORT}`).toBe(
    'function',
  );
  return candidate as ResolveReadiness;
}

function registeredWorkerServerTimeoutMs(testObject: object): number | undefined {
  let declared: number | undefined;
  for (const marker of Object.getOwnPropertySymbols(testObject)) {
    const impl = (testObject as Record<symbol, unknown>)[marker] as
      | { fixtures?: Array<{ fixtures?: Record<string, unknown> }> }
      | undefined;
    if (!Array.isArray(impl?.fixtures)) continue;
    for (const layer of impl.fixtures) {
      const entry = layer.fixtures?.workerServer;
      if (!Array.isArray(entry)) continue;
      const options = entry[1] as { timeout?: unknown } | undefined;
      if (typeof options?.timeout === 'number') declared = options.timeout;
    }
  }
  return declared;
}

type FixtureBody = (
  deps: Record<string, unknown>,
  use: (value: unknown) => Promise<void>,
  info: unknown,
) => Promise<void>;

interface DriveResult {
  setupError: unknown;
  teardownError: unknown;
  slotAfterSetup: FixtureSlot | undefined;
}

function snapshotSlot(instance: FixtureInstance | undefined): FixtureSlot | undefined {
  if (instance === undefined) return undefined;
  const missing = missingFixtureSlotMembers(instance);
  if (missing.length > 0) {
    throw new Error(workerInternalsCouplingMessage(workerInternals().version, missing));
  }
  const slot = instance._setupDescription.slot as FixtureSlot;
  return { timeout: slot.timeout, elapsed: slot.elapsed };
}

function unspentMs(slot: FixtureSlot): number {
  return slot.timeout - slot.elapsed;
}

async function driveWorkerFixture(
  body: FixtureBody,
  fixtureTimeoutMs: number,
): Promise<DriveResult> {
  const { FixtureRunner, TimeoutManager } = workerInternals();
  const makeTestInfo = () => {
    const manager = new TimeoutManager(PROJECT_TIMEOUT_MS);
    return {
      _timeoutManager: manager,
      config: {},
      project: {},
      parallelIndex: 0,
      workerIndex: 0,
      async _runWithTimeout(runnable: unknown, run: () => Promise<void>) {
        return manager.withRunnable(runnable, run);
      },
      async _runAsStep(_step: unknown, run: () => Promise<void>) {
        return run();
      },
    };
  };
  const registration = {
    id: 'meta-worker-server-budget',
    name: 'workerServer',
    location: { file: import.meta.filename, line: 1, column: 1 },
    scope: 'worker',
    fn: body,
    auto: false,
    option: false,
    timeout: fixtureTimeoutMs,
    customTitle: undefined,
    box: undefined,
    deps: [] as string[],
    super: undefined,
    optionOverride: false,
  };

  const runner = new FixtureRunner();
  runner.workerFixtureTimeout = PROJECT_TIMEOUT_MS;

  let setupError: unknown;
  let instance: FixtureInstance | undefined;
  try {
    instance = await runner._setupFixtureForRegistration(registration, makeTestInfo(), {
      type: 'test',
    });
  } catch (error) {
    setupError = error;
    instance = runner.instanceForId.get(registration.id);
  }
  const slotAfterSetup = snapshotSlot(instance);

  let teardownError: unknown;
  try {
    await runner.teardownScope('worker', makeTestInfo(), { type: 'teardown' });
  } catch (error) {
    teardownError = error;
  }

  return { setupError, teardownError, slotAfterSetup };
}

const spawnedChildren: ChildProcess[] = [];
const openedServers: Array<{ stop: () => Promise<void> }> = [];
const createdDirs: string[] = [];

function spawnStubDevCommand(source: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
  spawnedChildren.push(child);
  return child;
}

async function spawnReadyStubDevCommand(source: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] });
  spawnedChildren.push(child);
  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error(
      'the stub dev command was spawned without the stdout pipe it announces readiness on',
    );
  }
  await new Promise<void>((resolve, reject) => {
    let seen = '';
    const finish = (failure?: Error): void => {
      stdout.removeAllListeners('data');
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      stdout.resume();
      resolve();
    };
    stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes(STUB_READY_MARKER)) finish();
    });
    child.on('exit', () =>
      finish(new Error(`the stub dev command exited before announcing ${STUB_READY_MARKER}`)),
    );
    child.on('error', (err: Error) => finish(err));
  });
  return child;
}

function isReaped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopStubDevCommand(child: ChildProcess, boundMs: number): Promise<void> {
  if (isReaped(child)) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, wait(boundMs)]);
  if (isReaped(child)) return;
  child.kill('SIGKILL');
  await exited;
}

async function lateBindingServer(bindAfterMs: number): Promise<string> {
  const port = await getFreePort();
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  const bindTimer = setTimeout(() => {
    server.listen(port, LOOPBACK);
  }, bindAfterMs);
  openedServers.push({
    async stop() {
      clearTimeout(bindTimer);
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
  return `http://${LOOPBACK}:${port}`;
}

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-meta-budget-'));
  createdDirs.push(dir);
  return dir;
}

interface LifecycleOutcome {
  setupCompleted: boolean;
  teardownCompleted: boolean;
  childReaped: boolean;
  dirRemoved: boolean;
  slotAfterSetup: FixtureSlot | undefined;
}

async function driveServerLifecycle(options: {
  totalMs: number;
  setupSpendMs: number;
  teardownNeedMs: number;
  devCommand: string;
}): Promise<LifecycleOutcome> {
  const child = await spawnReadyStubDevCommand(options.devCommand);
  const dir = makeFixtureDir();
  let setupCompleted = false;
  let teardownCompleted = false;

  const driven = await driveWorkerFixture(async (_deps, use) => {
    await wait(options.setupSpendMs);
    setupCompleted = true;
    await use({ dir });
    await stopStubDevCommand(child, options.teardownNeedMs);
    rmSync(dir, { recursive: true, force: true });
    teardownCompleted = true;
  }, options.totalMs);

  return {
    setupCompleted,
    teardownCompleted,
    childReaped: isReaped(child),
    dirRemoved: !existsSync(dir),
    slotAfterSetup: driven.slotAfterSetup,
  };
}

afterEach(async () => {
  for (const server of openedServers.splice(0)) await server.stop();
  for (const child of spawnedChildren.splice(0)) {
    if (!isReaped(child)) child.kill('SIGKILL');
  }
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('worker-server fixture budget allocation', () => {
  test('the registered fixture timeout and the declared total are one number', async () => {
    const exports = await fixtureExports();
    const registered = registeredWorkerServerTimeoutMs(exports.test as object);
    expect(
      registered,
      'the workerServer registration must declare a numeric fixture timeout',
    ).toBeGreaterThan(0);

    const total = await declaredTotalMs();
    expect(typeof total, `${FIXTURE_MODULE} must export ${DECLARED_TOTAL_EXPORT}`).toBe('number');
    expect(total).toBe(registered);
  });

  test('the readiness share is what the one total has left after every named reserve', async () => {
    const table = await expectDeclaredReserveTable(await declaredReserves());
    const resolve = asResolveReadiness(await declaredResolveReadiness());
    const total = await declaredTotalMs();
    expect(typeof total).toBe('number');

    const readiness = resolve(total as number, table);
    expect(readiness).toBeGreaterThan(0);
    expect(readiness + sumReserves(table)).toBe(total);
  });

  test('the one total reserves for the teardown path, not only for setup', async () => {
    const table = await expectDeclaredReserveTable(await declaredReserves());
    expect(Object.keys(table)).toContain(TEARDOWN_RESERVE_KEY);
    expect(table[TEARDOWN_RESERVE_KEY]).toBeGreaterThan(0);
  });

  test('the one total reserves for the setup work no phase bound claims, not only for the bounded probes', async () => {
    const table = await expectDeclaredReserveTable(await declaredReserves());
    expect(
      Object.keys(table),
      'the fixture spends slot time on port allocation, the temp content dir, the vite-cache seed copy, the server log, the dev-server spawn and the browser-context lifecycle around warmup, none of which any bound-carrying phase reserves',
    ).toContain(SETUP_OVERHEAD_RESERVE_KEY);
    expect(table[SETUP_OVERHEAD_RESERVE_KEY]).toBeGreaterThan(0);
  });

  test('a total its own reserves already consume is refused, never a non-positive share', async () => {
    const resolve = asResolveReadiness(await declaredResolveReadiness());
    const reserves: ReserveTable = { setup: 4, [TEARDOWN_RESERVE_KEY]: 6 };
    const consumed = sumReserves(reserves);

    expect(() => resolve(consumed, reserves)).toThrow();
    expect(() => resolve(consumed - 1, reserves)).toThrow();
    expect(() => resolve(0, reserves)).toThrow();
    expect(resolve(consumed + 1, reserves)).toBe(1);
  });
});

const PROBE_PHASE_NAME = 'probe phase';
const PROBE_PHASE_RESERVE_MS = 400;
const PROBE_PHASE_OVERSPEND_MS = 25;
const PROBE_PHASE_RESIDUE = 'the probe child and its scratch dir';
const PROBE_WORKER_INDEX = 3;
const PROBE_ELAPSED_WAIT_MS = 5;
const PROBE_TIGHT_BOUND_MS = 1;

const FULL_FIXTURE_RUNNER_SHAPE: Record<string, unknown> = {
  instanceForId: new Map(),
  workerFixtureTimeout: 0,
  _setupFixtureForRegistration: () => undefined,
  teardownScope: () => undefined,
};

function plantedFixtureRunnerModule(shape: Record<string, unknown>): unknown {
  return {
    FixtureRunner: class {
      constructor() {
        Object.assign(this, shape);
      }
    },
  };
}

function plantedTimeoutManagerModule(
  options: { withRunnable?: boolean; managerError?: boolean } = {},
): unknown {
  class PlantedTimeoutManager {}
  if (options.withRunnable !== false) {
    (PlantedTimeoutManager.prototype as Record<string, unknown>).withRunnable = () => undefined;
  }
  return options.managerError === false
    ? { TimeoutManager: PlantedTimeoutManager }
    : { TimeoutManager: PlantedTimeoutManager, TimeoutManagerError: class extends Error {} };
}

function withoutMember(shape: Record<string, unknown>, member: string): Record<string, unknown> {
  const copy = { ...shape };
  delete copy[member];
  return copy;
}

describe('playwright worker-internals coupling', () => {
  test('the playwright this driver loads through @playwright/test is the exact version the app manifest declares', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { devDependencies?: Record<string, string> };
    const declared = manifest.devDependencies?.playwright;
    expect(
      declared,
      'the private worker modules this suite reads decide a required integration shard, so the version carrying them is declared rather than reached transitively',
    ).toBe(PLAYWRIGHT_WORKER_INTERNALS_VERIFIED_AT);
    expect(
      workerInternals().version,
      `this driver resolves playwright through @playwright/test's own require scope, and @playwright/test pins its playwright to its own version. So the manifest entry only describes what the driver loads while the two agree: a @playwright/test bump inside its caret moves the resolution and must red here rather than change a required shard's outcome silently`,
    ).toBe(declared);
  });

  test('the resolved playwright is at or above the verified release and supplies every member this driver reads', () => {
    const internals = workerInternals();
    expect(
      meetsVersionFloor(internals.version, PLAYWRIGHT_WORKER_INTERNALS_VERIFIED_AT),
      `the worker-internals driver was verified against playwright@${PLAYWRIGHT_WORKER_INTERNALS_VERIFIED_AT}`,
    ).toBe(true);
    expect(
      missingWorkerInternalsMembers(
        { FixtureRunner: internals.FixtureRunner },
        {
          TimeoutManager: internals.TimeoutManager,
          TimeoutManagerError: internals.TimeoutManagerError,
        },
      ),
      'the shape check must pass against the release these tests actually run on, or it reds every run instead of a moved member',
    ).toEqual([]);
  });

  test('the slot a constructed fixture instance carries still supplies the numeric members this driver measures headroom with', async () => {
    const driven = await driveWorkerFixture(async (_deps, use) => {
      await use({});
    }, SLOT_SHAPE_PROBE_TOTAL_MS);

    expect(
      driven.setupError,
      'a fixture body that only calls use() must reach teardown, or this probe read a failure rather than the slot',
    ).toBeUndefined();
    expect(driven.teardownError).toBeUndefined();

    const slot = driven.slotAfterSetup;
    expect(
      slot,
      `${WORKER_INTERNALS_EXPECTED.at(-1)} is what every headroom assertion in this file reads, and the module-shape gate never constructs a fixture instance to look at it`,
    ).toBeDefined();
    expect(Number.isFinite(slot?.timeout)).toBe(true);
    expect(Number.isFinite(slot?.elapsed)).toBe(true);
    expect(
      slot?.timeout,
      'the slot the driver reads must still be the one the fixture registration declares, not the worker-wide default it would silently fall back to',
    ).toBe(SLOT_SHAPE_PROBE_TOTAL_MS);

    expect(
      missingFixtureSlotMembers({
        _setupDescription: { slot: { limit: 1, spent: 0 } as unknown as FixtureSlot },
      }),
      'the must-fire control: a release that renamed both members must name them rather than hand back a slot whose reads are NaN',
    ).toEqual([
      `FixtureInstance#${FIXTURE_INSTANCE_SLOT_MEMBER}.slot.timeout`,
      `FixtureInstance#${FIXTURE_INSTANCE_SLOT_MEMBER}.slot.elapsed`,
    ]);
    expect(
      missingFixtureSlotMembers({
        _setupDescription: {
          slot: { timeout: Number.NaN, elapsed: 0 } as unknown as FixtureSlot,
        },
      }),
      'a present-but-NaN member is the one shape a check weakened to a typeof test would admit, and it is what leaks a bare NaN into unspentMs',
    ).toEqual([`FixtureInstance#${FIXTURE_INSTANCE_SLOT_MEMBER}.slot.timeout`]);
    expect(
      missingFixtureSlotMembers({
        _setupDescription: {
          slot: {
            timeout: SLOT_SHAPE_PROBE_TOTAL_MS,
            elapsed: Number.NaN,
          } as unknown as FixtureSlot,
        },
      }),
    ).toEqual([`FixtureInstance#${FIXTURE_INSTANCE_SLOT_MEMBER}.slot.elapsed`]);
    expect(missingFixtureSlotMembers({ _setupDescription: {} })).toEqual([
      `FixtureInstance#${FIXTURE_INSTANCE_SLOT_MEMBER}.slot`,
    ]);
    expect(missingFixtureSlotMembers(undefined)).toEqual([
      `FixtureInstance#${FIXTURE_INSTANCE_SLOT_MEMBER}`,
    ]);
  });

  test('a release that moved any member the driver reads is named at the load rather than several frames inside playwright', () => {
    expect(
      missingWorkerInternalsMembers(
        plantedFixtureRunnerModule(withoutMember(FULL_FIXTURE_RUNNER_SHAPE, 'teardownScope')),
        plantedTimeoutManagerModule(),
      ),
    ).toEqual(['FixtureRunner#teardownScope']);
    expect(
      missingWorkerInternalsMembers(
        plantedFixtureRunnerModule(
          withoutMember(FULL_FIXTURE_RUNNER_SHAPE, '_setupFixtureForRegistration'),
        ),
        plantedTimeoutManagerModule(),
      ),
    ).toEqual(['FixtureRunner#_setupFixtureForRegistration']);
    expect(
      missingWorkerInternalsMembers(
        plantedFixtureRunnerModule({ ...FULL_FIXTURE_RUNNER_SHAPE, instanceForId: {} }),
        plantedTimeoutManagerModule(),
      ),
    ).toEqual(['FixtureRunner#instanceForId is a Map']);
    expect(
      missingWorkerInternalsMembers(
        plantedFixtureRunnerModule(FULL_FIXTURE_RUNNER_SHAPE),
        plantedTimeoutManagerModule({ withRunnable: false }),
      ),
    ).toEqual(['TimeoutManager#withRunnable']);
    expect(
      missingWorkerInternalsMembers(
        plantedFixtureRunnerModule(FULL_FIXTURE_RUNNER_SHAPE),
        plantedTimeoutManagerModule({ managerError: false }),
      ),
    ).toEqual(['TimeoutManagerError']);
    expect(missingWorkerInternalsMembers(null, undefined)).toEqual([
      'FixtureRunner',
      'TimeoutManager',
      'TimeoutManagerError',
    ]);
    expect(
      missingWorkerInternalsMembers(
        plantedFixtureRunnerModule(FULL_FIXTURE_RUNNER_SHAPE),
        plantedTimeoutManagerModule(),
      ),
      'the planted full shape is the must-NOT-fire control for every case above',
    ).toEqual([]);
  });

  test('the verified-release pin admits a later release and refuses an earlier one', () => {
    expect(meetsVersionFloor('1.59.1', '1.59.1')).toBe(true);
    expect(meetsVersionFloor('1.59.2', '1.59.1')).toBe(true);
    expect(meetsVersionFloor('1.60.0', '1.59.1')).toBe(true);
    expect(meetsVersionFloor('2.0.0', '1.59.1')).toBe(true);
    expect(meetsVersionFloor('1.59.0', '1.59.1')).toBe(false);
    expect(meetsVersionFloor('1.58.9', '1.59.1')).toBe(false);
    expect(meetsVersionFloor('0.99.99', '1.59.1')).toBe(false);
    expect(meetsVersionFloor('1.59.1-alpha.1', '1.59.1')).toBe(true);
  });
});

describe('worker-server fixture budget guards', () => {
  test('the fixture and this suite judge a reserve table by one exported predicate', async () => {
    const isReserveTable = await declaredReserveTablePredicate();
    expect(isReserveTable({ setup: 1 })).toBe(true);
    expect(isReserveTable(await declaredReserves())).toBe(true);
    expect(isReserveTable({ setup: -1 })).toBe(false);
    expect(isReserveTable({ setup: 0 })).toBe(false);
    expect(isReserveTable({ setup: Number.NaN })).toBe(false);
    expect(isReserveTable({ setup: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isReserveTable({ setup: '1' })).toBe(false);
    expect(isReserveTable({})).toBe(false);
    expect(isReserveTable([1])).toBe(false);
    expect(isReserveTable(null)).toBe(false);
  });

  test('a reserve that is not a positive finite number is refused, never absorbed into a larger share', async () => {
    const resolve = asResolveReadiness(await declaredResolveReadiness());
    expect(resolve(10_000, { setup: 4_000 })).toBe(6_000);

    for (const rejected of [
      { setup: -50_000 },
      { setup: Number.NaN },
      { setup: Number.POSITIVE_INFINITY },
      { setup: 0 },
    ]) {
      expect(() => resolve(10_000, rejected as ReserveTable), JSON.stringify(rejected)).toThrow(
        /positive finite millisecond counts/,
      );
    }
    expect(() => resolve(10_000, {} as ReserveTable)).toThrow(/names no share at all/);
    expect(() => resolve(10_000, [] as unknown as ReserveTable)).toThrow(/an array/);
    expect(() => resolve(10_000, null as unknown as ReserveTable)).toThrow(/table of named shares/);
    expect(() => resolve(Number.NaN, { setup: 4_000 })).toThrow(/leaves no readiness share/);
  });

  test('a phase that overspends its declared reserve names the phase, the reserve, what it took and what the slot still owes', async () => {
    const exports = await fixtureExports();
    const openBudgetPhase = exports.openBudgetPhase as (
      name: string,
      reserveMs: number,
    ) => { name: string; reserveMs: number; spentMs: number };
    const budgetPhaseOverrunMessage = exports.budgetPhaseOverrunMessage as (
      phase: unknown,
      residue: string,
    ) => string | undefined;

    const phase = openBudgetPhase(PROBE_PHASE_NAME, PROBE_PHASE_RESERVE_MS);
    expect(phase.spentMs).toBe(0);
    expect(budgetPhaseOverrunMessage(phase, PROBE_PHASE_RESIDUE)).toBeUndefined();

    phase.spentMs = PROBE_PHASE_RESERVE_MS;
    expect(
      budgetPhaseOverrunMessage(phase, PROBE_PHASE_RESIDUE),
      'a phase that spends exactly its reserve is inside it, so the refusal must not fire on the boundary value',
    ).toBeUndefined();

    phase.spentMs = PROBE_PHASE_RESERVE_MS + PROBE_PHASE_OVERSPEND_MS;
    const message = budgetPhaseOverrunMessage(phase, PROBE_PHASE_RESIDUE);
    expect(
      message,
      'an overspent phase must report rather than absorb the slot in silence',
    ).toBeDefined();
    expect(message).toContain(PROBE_PHASE_NAME);
    expect(message).toContain(`spent ${PROBE_PHASE_RESERVE_MS + PROBE_PHASE_OVERSPEND_MS}ms`);
    expect(message).toContain(`${PROBE_PHASE_RESERVE_MS}ms reserve`);
    expect(message).toContain(`borrowing ${PROBE_PHASE_OVERSPEND_MS}ms`);
    expect(message).toContain(PROBE_PHASE_RESIDUE);
  });

  test('a phase accumulates the elapsed time of the work routed through it, including work that throws', async () => {
    const exports = await fixtureExports();
    const openBudgetPhase = exports.openBudgetPhase as (
      name: string,
      reserveMs: number,
    ) => { spentMs: number };
    const spendOnBudgetPhase = exports.spendOnBudgetPhase as <T>(
      phase: unknown,
      work: () => T | Promise<T>,
    ) => Promise<T>;

    const phase = openBudgetPhase(PROBE_PHASE_NAME, PROBE_PHASE_RESERVE_MS);
    expect(await spendOnBudgetPhase(phase, () => 'passed through')).toBe('passed through');

    const beforeWait = phase.spentMs;
    await spendOnBudgetPhase(phase, () => wait(PROBE_ELAPSED_WAIT_MS));
    expect(
      phase.spentMs,
      'a phase whose accumulator is not wired to elapsed time can never overrun, so its reserve would enforce nothing',
    ).toBeGreaterThan(beforeWait);

    const beforeThrow = phase.spentMs;
    await expect(
      spendOnBudgetPhase(phase, async () => {
        await wait(PROBE_ELAPSED_WAIT_MS);
        throw new Error('work that throws still spent the slot');
      }),
    ).rejects.toThrow('work that throws still spent the slot');
    expect(phase.spentMs).toBeGreaterThan(beforeThrow);
  });

  test('a phase opened without a positive finite reserve is refused where it is opened', async () => {
    const exports = await fixtureExports();
    const openBudgetPhase = exports.openBudgetPhase as (name: string, reserveMs: number) => unknown;
    expect(openBudgetPhase(PROBE_PHASE_NAME, PROBE_PHASE_RESERVE_MS)).toBeDefined();
    expect(() => openBudgetPhase(PROBE_PHASE_NAME, undefined as unknown as number)).toThrow(
      new RegExp(`budget phase "${PROBE_PHASE_NAME}"`),
    );
    expect(() => openBudgetPhase(PROBE_PHASE_NAME, Number.NaN)).toThrow(/millisecond bound/);
  });

  test('a phase over its reserve is refused only once the phases that have not run can no longer fit the slot', async () => {
    const exports = await fixtureExports();
    const openBudgetPhase = exports.openBudgetPhase as (
      name: string,
      reserveMs: number,
    ) => { spentMs: number };
    const refuseStarvedBudgetSlot = exports.refuseStarvedBudgetSlot as (
      phase: unknown,
      elapsedMs: number,
      residue: string,
    ) => void;
    const table = await expectDeclaredReserveTable(await declaredReserves());
    const total = await declaredTotalMs();
    expect(typeof total).toBe('number');
    const leftAfterSetup = exports.PHASES_LEFT_AFTER_SETUP as readonly string[];
    const unrunShares = leftAfterSetup.map((key) => table[key]);
    expect(
      unrunShares,
      'this oracle reads the same partition the fixture protects rather than re-declaring its own key pair, so a table that stopped declaring one of those phases reds here instead of letting the missing share read as nothing to protect',
    ).not.toContain(undefined);
    const unrunMs = unrunShares.reduce((sum, ms) => sum + (ms as number), 0);
    expect(unrunMs).toBeGreaterThan(0);
    const fits = (total as number) - unrunMs;

    const borrowing = openBudgetPhase(PROBE_PHASE_NAME, PROBE_PHASE_RESERVE_MS);
    borrowing.spentMs = PROBE_PHASE_RESERVE_MS + PROBE_PHASE_OVERSPEND_MS;

    expect(
      () => refuseStarvedBudgetSlot(borrowing, borrowing.spentMs, PROBE_PHASE_RESIDUE),
      'a phase that overspends its reserve while the slot still holds ample unclaimed time starves nothing, and refusing it re-creates the mis-blamed failure the derived budget exists to remove',
    ).not.toThrow();

    expect(
      () => refuseStarvedBudgetSlot(borrowing, fits, PROBE_PHASE_RESIDUE),
      'a setup that leaves the unrun phases exactly their reserves still fits, so the refusal must not fire on the boundary value',
    ).not.toThrow();

    expect(
      () => refuseStarvedBudgetSlot(borrowing, fits + 1, PROBE_PHASE_RESIDUE),
      'a setup that leaves the reap and teardown phases unable to run is the one harm a hard refusal is owed for',
    ).toThrow(new RegExp(`${DEV_SERVER_REAP_RESERVE_KEY} and ${TEARDOWN_RESERVE_KEY}`));
    expect(() => refuseStarvedBudgetSlot(borrowing, fits + 1, PROBE_PHASE_RESIDUE)).toThrow(
      PROBE_PHASE_RESIDUE,
    );
    expect(
      () => refuseStarvedBudgetSlot(borrowing, fits + 1, PROBE_PHASE_RESIDUE),
      'a starved slot whose setup phase also overspent must carry that drift, since the phase is where the spend is attributable',
    ).toThrow(new RegExp(`phase "${PROBE_PHASE_NAME}" spent`));

    const withinReserve = openBudgetPhase(PROBE_PHASE_NAME, PROBE_PHASE_RESERVE_MS);
    let starvedWithoutDrift: unknown;
    try {
      refuseStarvedBudgetSlot(withinReserve, fits + 1, PROBE_PHASE_RESIDUE);
    } catch (error) {
      starvedWithoutDrift = error;
    }
    expect(starvedWithoutDrift).toBeInstanceOf(Error);
    expect(
      String((starvedWithoutDrift as Error).message),
      'a phase inside its reserve has no drift to report, so the starvation must not invent one against it',
    ).not.toContain(`phase "${PROBE_PHASE_NAME}" spent`);
  });

  test('an overrun report reaches the console tagged with the worker that spent it, and a phase inside its reserve reports nothing', async () => {
    const exports = await fixtureExports();
    const openBudgetPhase = exports.openBudgetPhase as (
      name: string,
      reserveMs: number,
    ) => { spentMs: number };
    const reportBudgetOverrun = exports.reportBudgetOverrun as (
      phase: unknown,
      workerIndex: number,
      residue: string,
    ) => string | undefined;

    const warned: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warned.push(String(line));
    });
    let reportedOverrun: string | undefined;
    let reportedWithinReserve: string | undefined;
    try {
      const withinReserve = openBudgetPhase(PROBE_PHASE_NAME, PROBE_PHASE_RESERVE_MS);
      withinReserve.spentMs = PROBE_PHASE_RESERVE_MS;
      reportedWithinReserve = reportBudgetOverrun(
        withinReserve,
        PROBE_WORKER_INDEX,
        PROBE_PHASE_RESIDUE,
      );

      const borrowing = openBudgetPhase(PROBE_PHASE_NAME, PROBE_PHASE_RESERVE_MS);
      borrowing.spentMs = PROBE_PHASE_RESERVE_MS + PROBE_PHASE_OVERSPEND_MS;
      reportedOverrun = reportBudgetOverrun(borrowing, PROBE_WORKER_INDEX, PROBE_PHASE_RESIDUE);
    } finally {
      spy.mockRestore();
    }

    expect(
      reportedWithinReserve,
      'a phase that stayed inside its reserve has no borrow to report',
    ).toBeUndefined();
    expect(
      warned,
      'exactly one of the two phases borrowed, so exactly one line reaches the stream every worker in the tier shares',
    ).toHaveLength(1);
    expect(
      warned[0],
      'up to four workers interleave into one stream, so a report that cannot be attributed to a worker index cannot be read',
    ).toContain(`[fixture w${PROBE_WORKER_INDEX}]`);
    expect(warned[0]).toContain(PROBE_PHASE_RESIDUE);
    expect(reportedOverrun).toBe(warned[0]);
  });

  test('every declared reserve is either spent by setup or held for a phase the starvation check protects', async () => {
    const exports = await fixtureExports();
    const table = await expectDeclaredReserveTable(await declaredReserves());
    const spentBySetup = exports.PHASES_SPENT_BY_SETUP as readonly string[];
    const leftAfterSetup = exports.PHASES_LEFT_AFTER_SETUP as readonly string[];

    expect(
      [...spentBySetup, ...leftAfterSetup].sort(),
      'the two partitions must cover the live reserve table exactly, so a reserve added for a phase nobody classified cannot be left out of the starvation arithmetic',
    ).toEqual(Object.keys(table).sort());
    expect(
      spentBySetup.filter((key) => leftAfterSetup.includes(key)),
      'a phase counted as both spent and unrun would be reserved against itself',
    ).toEqual([]);
    expect(
      leftAfterSetup,
      'the phases the refusal protects are derived from the table rather than hand-listed, so an unclassified key defaults to being protected',
    ).toContain(DEV_SERVER_REAP_RESERVE_KEY);
    expect(leftAfterSetup).toContain(TEARDOWN_RESERVE_KEY);
  });

  test('the fixture body opens both headroom phases, spends on them, reports their overruns and refuses only a starved slot', () => {
    const counts = budgetEnforcementCounts(fixtureSource());
    expect(
      counts,
      'this scope opens both headroom phases and reports the setup-overhead overrun at three checkpoints: before readiness, again after warmupAppFirstLoad has charged the browser-context lifecycle to the same phase, and once for teardown. The third is the one the post-warmup segment depends on, because refuseStarvedBudgetSlot only reaches a message when the slot is starved. budgetPhaseOverrunMessage is called directly once, on the failure path, where the report is folded into the thrown error instead of warned',
    ).toEqual({
      openBudgetPhase: 2,
      spendOnBudgetPhase: 2,
      refuseStarvedBudgetSlot: 1,
      reportBudgetOverrun: 3,
      budgetPhaseOverrunMessage: 1,
      warn: 0,
    });

    expect(
      budgetEnforcementCounts(fixtureSource(), { kind: 'function', name: 'warmupAppFirstLoad' }),
      'the three wraps around newContext, newPage and close are the only calls charging the browser-context lifecycle to the setup-overhead reserve its own justification names, and every one of them sits outside the fixture body the assertion above scans',
    ).toEqual({
      openBudgetPhase: 0,
      spendOnBudgetPhase: 3,
      refuseStarvedBudgetSlot: 0,
      reportBudgetOverrun: 0,
      budgetPhaseOverrunMessage: 0,
      warn: 0,
    });

    const withoutStarvationRefusal = budgetEnforcementCounts(
      mutatedFixtureSource('refuseStarvedBudgetSlot(setupOverhead,', 'void (setupOverhead,'),
    );
    expect(
      withoutStarvationRefusal.refuseStarvedBudgetSlot,
      'the count must move when the refusal is removed, or it is a constant dressed as a check',
    ).toBe(0);

    const withoutPostWarmupReport = budgetEnforcementCounts(
      mutatedFixtureSource(
        `          fixtureStartedAt + WORKER_SERVER_SETUP_STARVATION_LINE_MS,
        );
        reportBudgetOverrun(setupOverhead, workerInfo.workerIndex, residue);`,
        `          fixtureStartedAt + WORKER_SERVER_SETUP_STARVATION_LINE_MS,
        );`,
      ),
    );
    expect(
      withoutPostWarmupReport.reportBudgetOverrun,
      'dropping the post-warmup checkpoint must move the count, or the browser-context legs accumulate into the phase and are discarded unreported on every slot that is not starved',
    ).toBe(2);

    const withoutContextCloseWrap = budgetEnforcementCounts(
      mutatedFixtureSource(
        'await spendOnBudgetPhase(overhead, () => closeBeforeDeadline(context, deadlineAt));',
        'await closeBeforeDeadline(context, deadlineAt);',
      ),
      { kind: 'function', name: 'warmupAppFirstLoad' },
    );
    expect(
      withoutContextCloseWrap.spendOnBudgetPhase,
      'unwrapping one lifecycle call must move the warmup count, or the scoped assertion is a constant dressed as a check',
    ).toBe(2);
  });

  test('a rollback reports a directory that is still on disk, whether the removal threw or returned', () => {
    const removed = makeFixtureDir();
    expect(
      rollbackPreparedViteCacheDir(removed),
      'a rollback that removed its directory has nothing to report',
    ).toBeUndefined();
    expect(existsSync(removed)).toBe(false);

    const refusal = new Error('EPERM: operation not permitted, rmdir');
    let thrownByRollback: unknown;
    let reportedOnThrow: string | undefined;
    try {
      reportedOnThrow = rollbackPreparedViteCacheDir(removed, () => {
        throw refusal;
      });
    } catch (err) {
      thrownByRollback = err;
    }
    expect(
      thrownByRollback,
      'a throwing rollback would propagate instead of the cpSync failure it is cleaning up after, and that failure is the only account of why setup aborted',
    ).toBeUndefined();
    expect(reportedOnThrow).toContain(refusal.message);
    expect(reportedOnThrow).toContain(removed);

    const survived = makeFixtureDir();
    expect(
      rollbackPreparedViteCacheDir(survived, () => {}),
      'rmSync can return without throwing while the path survives (nodejs/node#38683), so a rollback that read only the throw would report success for a seed directory still on disk. Checking the directory is gone is what makes that outcome reportable whichever removal primitive this call defaults to',
    ).toContain(survived);
  });

  test('a readiness probe called without its bound names the bound and the call site instead of timing out at ~1ms', async () => {
    const exports = await fixtureExports();
    const checkApiConfig = exports.checkApiConfig as (
      baseURL: string,
      timeoutMs: number,
    ) => Promise<void>;

    expect(requireBoundMs(PROBE_PHASE_RESERVE_MS, 'probe')).toBe(PROBE_PHASE_RESERVE_MS);
    expect(() => requireBoundMs(0, 'probe')).toThrow(/probe needs its caller/);
    expect(() => requireBoundMs(undefined as unknown as number, 'probe')).toThrow(/undefined/);

    const deadURL = `http://${LOOPBACK}:${await getFreePort()}`;
    await expect(checkApiConfig(deadURL, undefined as unknown as number)).rejects.toThrow(
      /checkApiConfig needs its caller to name the millisecond bound/,
    );
    await expect(
      checkApiConfig(deadURL, PROBE_TIGHT_BOUND_MS),
      'a probe handed a real bound must reach its own network failure, not the missing-bound refusal',
    ).rejects.toThrow(/\/api\/config did not respond within/);

    await expect(
      checkCollabSync(await getFreePort(), undefined as unknown as number),
    ).rejects.toThrow(/checkCollabSync needs its caller to name the millisecond bound/);
    await expect(checkCollabSync(await getFreePort(), Number.NaN)).rejects.toThrow(
      /checkCollabSync needs its caller to name the millisecond bound/,
    );

    await expect(
      waitForHttpReady(deadURL, undefined as unknown as number),
      'an omitted bound makes the loop guard a NaN comparison, so the wait skips its body entirely and reports a near-instant readiness failure with no last error rather than the missing argument it is',
    ).rejects.toThrow(/waitForHttpReady needs its caller to name the millisecond bound/);
    await expect(waitForHttpReady(deadURL, Number.NaN)).rejects.toThrow(
      /waitForHttpReady needs its caller to name the millisecond bound/,
    );
    await expect(
      waitForHttpReady(deadURL, PROBE_TIGHT_BOUND_MS),
      'a wait handed a real bound must reach its own readiness failure, not the missing-bound refusal',
    ).rejects.toThrow(/did not become ready within/);
  });
});

describe('worker-server fixture budget behaviour', () => {
  test('a dev server binding past an undeclared literal but inside the derived share is admitted', async () => {
    const resolve = asResolveReadiness(await declaredResolveReadiness());
    const derived = resolve(ADMISSION_TOTAL_MS, ADMISSION_RESERVES);
    expect(derived + sumReserves(ADMISSION_RESERVES)).toBe(ADMISSION_TOTAL_MS);
    expect(derived).toBeGreaterThan(SERVER_BINDS_AFTER_MS);
    expect(UNDERIVED_READINESS_MS).toBeLessThan(SERVER_BINDS_AFTER_MS);

    const undeclaredURL = await lateBindingServer(SERVER_BINDS_AFTER_MS);
    const undeclaredChild = spawnStubDevCommand(LONG_LIVED_DEV_COMMAND);
    let undeclaredAdmitted = false;
    const undeclared = await driveWorkerFixture(async (_deps, use) => {
      await waitForHttpReady(undeclaredURL, UNDERIVED_READINESS_MS, undeclaredChild);
      undeclaredAdmitted = true;
      await use({ baseURL: undeclaredURL });
    }, ADMISSION_TOTAL_MS);

    expect(undeclaredAdmitted).toBe(false);
    expect(String(undeclared.setupError)).toContain('did not become ready');
    expect(undeclared.slotAfterSetup).toBeDefined();
    expect(unspentMs(undeclared.slotAfterSetup as FixtureSlot)).toBeGreaterThan(0);

    const derivedURL = await lateBindingServer(SERVER_BINDS_AFTER_MS);
    const derivedChild = spawnStubDevCommand(LONG_LIVED_DEV_COMMAND);
    let derivedAdmitted = false;
    const admitted = await driveWorkerFixture(async (_deps, use) => {
      await waitForHttpReady(derivedURL, derived, derivedChild);
      derivedAdmitted = true;
      await use({ baseURL: derivedURL });
    }, ADMISSION_TOTAL_MS);

    expect(admitted.setupError).toBeUndefined();
    expect(derivedAdmitted).toBe(true);
  });

  test('setup spending its whole derived allocation still leaves teardown able to reap', async () => {
    const resolve = asResolveReadiness(await declaredResolveReadiness());
    const reserves: ReserveTable = {
      ...RESERVE_SETUP_SHARES,
      [TEARDOWN_RESERVE_KEY]: RESERVE_TEARDOWN_MS,
    };
    const readiness = resolve(RESERVE_TOTAL_MS, reserves);
    const setupSpendMs = readiness + sumReserves(RESERVE_SETUP_SHARES);
    expect(setupSpendMs + RESERVE_TEARDOWN_MS).toBe(RESERVE_TOTAL_MS);
    const teardownNeedMs = Math.floor(
      (RESERVE_TOTAL_MS - setupSpendMs) / RESERVE_TEARDOWN_NEED_SHARE,
    );
    expect(
      teardownNeedMs,
      'the work teardown simulates is a fraction of what the slot still owes it, so ordinary timer overshoot cannot decide this assertion the way a need sized close to the deadline would',
    ).toBeLessThan(RESERVE_TEARDOWN_MS);

    const outcome = await driveServerLifecycle({
      totalMs: RESERVE_TOTAL_MS,
      setupSpendMs,
      teardownNeedMs,
      devCommand: REAPED_ON_SIGTERM_DEV_COMMAND,
    });

    expect(outcome.setupCompleted).toBe(true);
    expect(outcome.teardownCompleted).toBe(true);
    expect(outcome.childReaped).toBe(true);
    expect(outcome.dirRemoved).toBe(true);
  });

  test('budget setup spends is budget teardown never gets, so an unreserved teardown is lost', async () => {
    const frugal = await driveServerLifecycle({
      totalMs: SHARED_SLOT_TOTAL_MS,
      setupSpendMs: SHARED_SLOT_FRUGAL_SETUP_MS,
      teardownNeedMs: SHARED_SLOT_TEARDOWN_NEED_MS,
      devCommand: STUBBORN_DEV_COMMAND,
    });
    expect(frugal.setupCompleted).toBe(true);
    expect(frugal.teardownCompleted).toBe(true);
    expect(frugal.childReaped).toBe(true);
    expect(frugal.dirRemoved).toBe(true);

    const greedy = await driveServerLifecycle({
      totalMs: SHARED_SLOT_TOTAL_MS,
      setupSpendMs: SHARED_SLOT_GREEDY_SETUP_MS,
      teardownNeedMs: SHARED_SLOT_TEARDOWN_NEED_MS,
      devCommand: STUBBORN_DEV_COMMAND,
    });
    expect(greedy.setupCompleted).toBe(true);
    expect(greedy.slotAfterSetup).toBeDefined();
    expect(unspentMs(greedy.slotAfterSetup as FixtureSlot)).toBeLessThan(
      SHARED_SLOT_TEARDOWN_NEED_MS,
    );
    expect(greedy.teardownCompleted).toBe(false);
    expect(greedy.childReaped).toBe(false);
    expect(greedy.dirRemoved).toBe(false);
  });

  test('a dev server that never binds still reds in readiness vocabulary inside the slot', async () => {
    const { TimeoutManagerError } = workerInternals();
    const unboundURL = `http://${LOOPBACK}:${await getFreePort()}`;
    const child = spawnStubDevCommand(LONG_LIVED_DEV_COMMAND);

    const driven = await driveWorkerFixture(async (_deps, use) => {
      await waitForHttpReady(unboundURL, NEVER_READY_SHARE_MS, child);
      await use({ baseURL: unboundURL });
    }, GUARD_TOTAL_MS);

    expect(driven.setupError).toBeInstanceOf(Error);
    expect(driven.setupError).not.toBeInstanceOf(TimeoutManagerError);
    expect(String((driven.setupError as Error).message)).toContain(
      `did not become ready within ${NEVER_READY_SHARE_MS}ms`,
    );
    expect(driven.slotAfterSetup).toBeDefined();
    expect(unspentMs(driven.slotAfterSetup as FixtureSlot)).toBeGreaterThan(0);
  });

  test('a dev command that exits early is named by its exit even under a generous share', async () => {
    const { TimeoutManagerError } = workerInternals();
    const unboundURL = `http://${LOOPBACK}:${await getFreePort()}`;
    const child = spawnStubDevCommand(IMMEDIATELY_EXITING_DEV_COMMAND);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const driven = await driveWorkerFixture(async (_deps, use) => {
      await waitForHttpReady(unboundURL, GENEROUS_READINESS_SHARE_MS, child);
      await use({ baseURL: unboundURL });
    }, GUARD_TOTAL_MS);

    expect(driven.setupError).toBeInstanceOf(Error);
    expect(driven.setupError).not.toBeInstanceOf(TimeoutManagerError);
    expect(String((driven.setupError as Error).message)).toMatch(
      /exited with code 7 after \d+ms without becoming ready/,
    );
  });
});

const FIXTURE_SOURCE_PATH = join(
  dirname(import.meta.filename),
  '..',
  'stress',
  '_helpers',
  'fixtures.ts',
);

const SERVER_PROCESS_SOURCE_PATH = join(
  dirname(import.meta.filename),
  '..',
  'stress',
  '_helpers',
  'server-process.ts',
);

const READINESS_BOUND_SITE = 'waitForServerReady -> waitForHttpReady readiness bound';
const WARMUP_NAVIGATION_STALL_SITE = 'warmupAppFirstLoad -> gotoWhileLoadProgresses stall window';
const WARMUP_VISIBLE_SITE = 'warmupAppFirstLoad -> locator.waitFor visibility bound';
const DEV_SERVER_REAP_SITE = 'workerServer fixture body -> killGracefully reap bound';
const STARVATION_ELAPSED_SITE =
  'workerServer fixture body -> refuseStarvedBudgetSlot elapsed-since-fixture-start argument';
const FIXTURE_START_IDENTIFIER = 'fixtureStartedAt';
const API_CONFIG_PROBE_SITE = 'waitForServerReady -> checkApiConfig probe bound';
const COLLAB_SYNC_PROBE_SITE = 'waitForServerReady -> checkCollabSync probe bound';

const WARMUP_GOTO_RESERVE_KEY = 'warmupGoto';
const WARMUP_VISIBLE_RESERVE_KEY = 'warmupVisible';
const DEV_SERVER_REAP_RESERVE_KEY = 'devServerReap';
const API_CONFIG_RESERVE_KEY = 'apiConfig';
const COLLAB_SYNC_RESERVE_KEY = 'collabSync';

const BUDGET_EXPORT_NAMES: ReadonlySet<string> = new Set([
  DECLARED_TOTAL_EXPORT,
  DECLARED_RESERVES_EXPORT,
  RESOLVE_READINESS_EXPORT,
  RESOLVE_FIRST_LOAD_STALL_EXPORT,
]);

type BudgetScope = { kind: 'function'; name: string } | { kind: 'worker-server-fixture-body' };

type BudgetArgument = { kind: 'positional'; index: number } | { kind: 'option'; name: string };

type BudgetRequirement =
  | { kind: 'derived'; root: string; key?: string }
  | { kind: 'reserve'; key: string }
  | { kind: 'elapsed-since'; start: string };

interface BudgetWiringSite {
  site: string;
  scope: BudgetScope;
  callee: string;
  calls: number;
  argument: BudgetArgument;
  requires: BudgetRequirement;
}

/* precedent #42: the load-bearing half of this call-site rule matches a reserve key found in
   source against the value of a runtime-imported WORKER_SERVER_BUDGET_RESERVES, which an oxlint
   visitor cannot reach, so the smallest alternative that keeps one enforcement path is this scan. */
const BUDGET_WIRING_SITES: readonly BudgetWiringSite[] = [
  {
    site: READINESS_BOUND_SITE,
    scope: { kind: 'function', name: 'waitForServerReady' },
    callee: 'waitForHttpReady',
    calls: 1,
    argument: { kind: 'positional', index: 1 },
    requires: { kind: 'derived', root: RESOLVE_READINESS_EXPORT },
  },
  {
    site: WARMUP_NAVIGATION_STALL_SITE,
    scope: { kind: 'function', name: 'warmupAppFirstLoad' },
    callee: 'gotoWhileLoadProgresses',
    calls: 1,
    argument: { kind: 'positional', index: 2 },
    requires: {
      kind: 'derived',
      root: RESOLVE_FIRST_LOAD_STALL_EXPORT,
      key: WARMUP_GOTO_RESERVE_KEY,
    },
  },
  {
    site: WARMUP_VISIBLE_SITE,
    scope: { kind: 'function', name: 'warmupAppFirstLoad' },
    callee: 'waitFor',
    calls: 1,
    argument: { kind: 'option', name: 'timeout' },
    requires: { kind: 'reserve', key: WARMUP_VISIBLE_RESERVE_KEY },
  },
  {
    site: DEV_SERVER_REAP_SITE,
    scope: { kind: 'worker-server-fixture-body' },
    callee: 'killGracefully',
    calls: 2,
    argument: { kind: 'positional', index: 1 },
    requires: { kind: 'reserve', key: DEV_SERVER_REAP_RESERVE_KEY },
  },
  {
    site: STARVATION_ELAPSED_SITE,
    scope: { kind: 'worker-server-fixture-body' },
    callee: 'refuseStarvedBudgetSlot',
    calls: 1,
    argument: { kind: 'positional', index: 1 },
    requires: { kind: 'elapsed-since', start: FIXTURE_START_IDENTIFIER },
  },
  {
    site: API_CONFIG_PROBE_SITE,
    scope: { kind: 'function', name: 'waitForServerReady' },
    callee: 'checkApiConfig',
    calls: 1,
    argument: { kind: 'positional', index: 1 },
    requires: { kind: 'reserve', key: API_CONFIG_RESERVE_KEY },
  },
  {
    site: COLLAB_SYNC_PROBE_SITE,
    scope: { kind: 'function', name: 'waitForServerReady' },
    callee: 'checkCollabSync',
    calls: 1,
    argument: { kind: 'positional', index: 1 },
    requires: { kind: 'reserve', key: COLLAB_SYNC_RESERVE_KEY },
  },
];

type BudgetWiringFinding =
  | { site: string; line: number; reason: 'scope-missing' }
  | { site: string; line: number; reason: 'call-count'; expected: number; found: number }
  | { site: string; line: number; reason: 'argument-missing' }
  | { site: string; line: number; reason: 'free-literal'; literals: number[] }
  | { site: string; line: number; reason: 'unlinked'; text: string }
  | { site: string; line: number; reason: 'wrong-reserve'; expected: string; found: string[] };

interface ResolvedBudgetCall {
  site: string;
  line: number;
  argument: string;
}

interface BudgetUse {
  reserveKeys: string[];
  budgetRoots: string[];
  literals: number[];
}

const budgetScanProject = new Project({
  useInMemoryFileSystem: true,
  skipFileDependencyResolution: true,
  skipLoadingLibFiles: true,
  skipAddingFilesFromTsConfig: true,
  compilerOptions: { noLib: true, allowJs: false },
});

let budgetScanCounter = 0;

function parseBudgetSource(source: string): SourceFile {
  budgetScanCounter += 1;
  return budgetScanProject.createSourceFile(`/budget-scan-${budgetScanCounter}.ts`, source, {
    overwrite: true,
  });
}

function excerptOf(node: Node): string {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function namedValueInitializer(sourceFile: SourceFile, name: string): Node | undefined {
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (declaration.getName() !== name) continue;
    const initializer = declaration.getInitializer();
    if (initializer !== undefined) return initializer;
  }
  return undefined;
}

function reservesAliases(sourceFile: SourceFile): ReadonlySet<string> {
  const aliases = new Set<string>([DECLARED_RESERVES_EXPORT]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initializer = declaration.getInitializer();
      if (initializer === undefined || !initializer.isKind(SyntaxKind.Identifier)) continue;
      if (!aliases.has(initializer.getText())) continue;
      if (aliases.has(declaration.getName())) continue;
      aliases.add(declaration.getName());
      grew = true;
    }
  }
  return aliases;
}

function resolveBudgetUse(
  expression: Node,
  sourceFile: SourceFile,
  aliases: ReadonlySet<string>,
): BudgetUse {
  const reserveKeys = new Set<string>();
  const budgetRoots = new Set<string>();
  const literals: number[] = [];
  const expandedNames = new Set<string>();

  const visit = (node: Node): void => {
    if (
      node.isKind(SyntaxKind.ParenthesizedExpression) ||
      node.isKind(SyntaxKind.AsExpression) ||
      node.isKind(SyntaxKind.NonNullExpression) ||
      node.isKind(SyntaxKind.SatisfiesExpression)
    ) {
      visit(node.getExpression());
      return;
    }

    if (node.isKind(SyntaxKind.NumericLiteral)) {
      literals.push(Number(node.getText().replaceAll('_', '')));
      return;
    }

    if (node.isKind(SyntaxKind.PrefixUnaryExpression)) {
      visit(node.getOperand());
      return;
    }

    if (node.isKind(SyntaxKind.BinaryExpression)) {
      visit(node.getLeft());
      visit(node.getRight());
      return;
    }

    if (node.isKind(SyntaxKind.ConditionalExpression)) {
      visit(node.getWhenTrue());
      visit(node.getWhenFalse());
      return;
    }

    if (node.isKind(SyntaxKind.PropertyAccessExpression)) {
      const target = node.getExpression();
      if (target.isKind(SyntaxKind.Identifier) && aliases.has(target.getText())) {
        budgetRoots.add(DECLARED_RESERVES_EXPORT);
        reserveKeys.add(node.getName());
      }
      return;
    }

    if (node.isKind(SyntaxKind.CallExpression)) {
      const callee = calleeName(node);
      if (!BUDGET_EXPORT_NAMES.has(callee)) return;
      budgetRoots.add(callee);
      for (const argument of node.getArguments()) visit(argument);
      return;
    }

    if (node.isKind(SyntaxKind.Identifier)) {
      const name = node.getText();
      if (BUDGET_EXPORT_NAMES.has(name)) {
        budgetRoots.add(name);
        return;
      }
      if (expandedNames.has(name)) return;
      expandedNames.add(name);
      const initializer = namedValueInitializer(sourceFile, name);
      if (initializer !== undefined) visit(initializer);
    }
  };

  visit(expression);

  return {
    reserveKeys: [...reserveKeys].sort(),
    budgetRoots: [...budgetRoots].sort(),
    literals,
  };
}

function calleeName(call: CallExpression): string {
  const callee = call.getExpression();
  return callee.isKind(SyntaxKind.PropertyAccessExpression) ? callee.getName() : callee.getText();
}

function workerServerFixtureBody(sourceFile: SourceFile): Node | undefined {
  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (property.getName() !== 'workerServer') continue;
    const initializer = property.getInitializer();
    if (initializer === undefined || !initializer.isKind(SyntaxKind.ArrayLiteralExpression)) {
      continue;
    }
    const body = initializer.getElements()[0];
    if (body === undefined) continue;
    if (body.isKind(SyntaxKind.ArrowFunction) || body.isKind(SyntaxKind.FunctionExpression)) {
      return body;
    }
  }
  return undefined;
}

function budgetScopeNode(sourceFile: SourceFile, scope: BudgetScope): Node | undefined {
  if (scope.kind === 'worker-server-fixture-body') return workerServerFixtureBody(sourceFile);
  const declared = sourceFile.getFunction(scope.name);
  if (declared !== undefined) return declared;
  const initializer = namedValueInitializer(sourceFile, scope.name);
  if (initializer === undefined) return undefined;
  const isFunctionValue =
    initializer.isKind(SyntaxKind.ArrowFunction) ||
    initializer.isKind(SyntaxKind.FunctionExpression);
  return isFunctionValue ? initializer : undefined;
}

function budgetCallsWithin(scope: Node, callee: string): CallExpression[] {
  return scope
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => calleeName(call) === callee);
}

function budgetArgumentNode(call: CallExpression, argument: BudgetArgument): Node | undefined {
  if (argument.kind === 'positional') return call.getArguments()[argument.index];
  const last = call.getArguments().at(-1);
  if (last === undefined || !last.isKind(SyntaxKind.ObjectLiteralExpression)) return undefined;
  for (const property of last.getProperties()) {
    if (!property.isKind(SyntaxKind.PropertyAssignment)) continue;
    if (property.getName() !== argument.name) continue;
    return property.getInitializer();
  }
  return undefined;
}

function isElapsedSince(argument: Node, start: string): boolean {
  const binary = argument.asKind(SyntaxKind.BinaryExpression);
  if (binary === undefined) return false;
  if (binary.getOperatorToken().getKind() !== SyntaxKind.MinusToken) return false;
  const taken = binary.getLeft().asKind(SyntaxKind.CallExpression);
  if (taken === undefined) return false;
  if (taken.getExpression().getText() !== 'Date.now') return false;
  const since = binary.getRight().asKind(SyntaxKind.Identifier);
  return since !== undefined && since.getText() === start;
}

const DRAIN_CALLEE = 'runTeardownPhases';
const DRAIN_COMPOSITION_PARTS = ['reason', 'borrowed', 'drainFailure', 'tail'] as const;

function mutatedFixtureSource(from: string, to: string): string {
  const source = fixtureSource();
  const mutated = source.replace(from, to);
  expect(
    mutated,
    `this control's mutation literal no longer matches ${FIXTURE_SOURCE_PATH}, so the assertion below would report the behaviour it guards as broken when what actually went stale is the literal`,
  ).not.toBe(source);
  return mutated;
}

function drainGuardFindings(source: string): string[] {
  const sourceFile = parseBudgetSource(source);
  const body = workerServerFixtureBody(sourceFile);
  if (body === undefined) return ['scope-missing'];
  const calls = budgetCallsWithin(body, DRAIN_CALLEE);
  if (calls.length !== 1) return ['drain-call-count'];
  const call = calls[0] as CallExpression;

  const findings: string[] = [];
  const nearestTry = call.getFirstAncestorByKind(SyntaxKind.TryStatement);
  const guarded =
    nearestTry !== undefined &&
    nearestTry.getCatchClause() !== undefined &&
    nearestTry.getTryBlock().getStart() <= call.getStart() &&
    nearestTry.getTryBlock().getEnd() >= call.getEnd();
  if (!guarded) findings.push('drain-unguarded');

  const thrown = body
    .getDescendantsOfKind(SyntaxKind.ThrowStatement)
    .find((statement) => statement.getStart() > call.getStart());
  if (thrown === undefined) {
    findings.push('drain-rethrow-missing');
    return findings;
  }
  const named = new Set(
    thrown.getDescendantsOfKind(SyntaxKind.Identifier).map((identifier) => identifier.getText()),
  );
  for (const part of DRAIN_COMPOSITION_PARTS) {
    if (!named.has(part)) findings.push(`drain-drops-${part}`);
  }
  return findings;
}

const SETUP_NON_RESULT_DECLARER = 'declareSetupNonResult';
const SETUP_NON_RESULT_DECLARATION = '        declareSetupNonResult(base.info(), reason);\n';
const DRAIN_BLOCK_OPENER = '        let drainFailure: string | undefined;\n';

function setupNonResultDeclarationFindings(source: string): string[] {
  const sourceFile = parseBudgetSource(source);
  const body = workerServerFixtureBody(sourceFile);
  if (body === undefined) return ['scope-missing'];
  const drains = budgetCallsWithin(body, DRAIN_CALLEE);
  if (drains.length !== 1) return ['drain-call-count'];
  const drain = drains[0] as CallExpression;
  const thrown = body
    .getDescendantsOfKind(SyntaxKind.ThrowStatement)
    .find((statement) => statement.getStart() > drain.getStart());
  if (thrown === undefined) return ['drain-rethrow-missing'];

  const declarations = budgetCallsWithin(body, SETUP_NON_RESULT_DECLARER);
  if (declarations.length === 0) return ['declaration-missing'];
  const findings = declarations.length === 1 ? [] : ['declaration-count'];
  for (const declaration of declarations) {
    if (declaration.getStart() < drain.getEnd()) {
      findings.push('declaration-before-drain');
    } else if (declaration.getEnd() > thrown.getStart()) {
      findings.push('declaration-after-throw');
    } else if (
      declaration.getParentIfKind(SyntaxKind.ExpressionStatement)?.getParent() !==
      thrown.getParent()
    ) {
      findings.push('declaration-off-the-rethrow-path');
    }
  }
  return findings;
}

function checkBudgetWiringSite(
  sourceFile: SourceFile,
  spec: BudgetWiringSite,
): BudgetWiringFinding[] {
  const scope = budgetScopeNode(sourceFile, spec.scope);
  if (scope === undefined) return [{ site: spec.site, line: 0, reason: 'scope-missing' }];

  const calls = budgetCallsWithin(scope, spec.callee);
  const findings: BudgetWiringFinding[] = [];
  if (calls.length !== spec.calls) {
    findings.push({
      site: spec.site,
      line: scope.getStartLineNumber(),
      reason: 'call-count',
      expected: spec.calls,
      found: calls.length,
    });
  }

  const aliases = reservesAliases(sourceFile);
  for (const call of calls) {
    const line = call.getStartLineNumber();
    const argument = budgetArgumentNode(call, spec.argument);
    if (argument === undefined) {
      findings.push({ site: spec.site, line, reason: 'argument-missing' });
      continue;
    }
    const use = resolveBudgetUse(argument, sourceFile, aliases);
    if (use.literals.length > 0) {
      findings.push({ site: spec.site, line, reason: 'free-literal', literals: use.literals });
      continue;
    }
    if (spec.requires.kind === 'derived') {
      const { root, key } = spec.requires;
      if (!use.budgetRoots.includes(root)) {
        findings.push({ site: spec.site, line, reason: 'unlinked', text: excerptOf(argument) });
      } else if (
        key !== undefined &&
        !(use.reserveKeys.length === 1 && use.reserveKeys[0] === key)
      ) {
        findings.push({
          site: spec.site,
          line,
          reason: 'wrong-reserve',
          expected: key,
          found: use.reserveKeys,
        });
      }
      continue;
    }
    if (spec.requires.kind === 'elapsed-since') {
      if (!isElapsedSince(argument, spec.requires.start)) {
        findings.push({ site: spec.site, line, reason: 'unlinked', text: excerptOf(argument) });
      }
      continue;
    }
    if (use.reserveKeys.length === 1 && use.reserveKeys[0] === spec.requires.key) continue;
    if (use.reserveKeys.length === 0 && use.budgetRoots.length === 0) {
      findings.push({ site: spec.site, line, reason: 'unlinked', text: excerptOf(argument) });
      continue;
    }
    findings.push({
      site: spec.site,
      line,
      reason: 'wrong-reserve',
      expected: spec.requires.key,
      found: use.reserveKeys,
    });
  }
  return findings;
}

function scanBudgetWiring(source: string): BudgetWiringFinding[] {
  const sourceFile = parseBudgetSource(source);
  return BUDGET_WIRING_SITES.flatMap((spec) => checkBudgetWiringSite(sourceFile, spec));
}

function resolvedBudgetCalls(source: string): ResolvedBudgetCall[] {
  const sourceFile = parseBudgetSource(source);
  const resolved: ResolvedBudgetCall[] = [];
  for (const spec of BUDGET_WIRING_SITES) {
    const scope = budgetScopeNode(sourceFile, spec.scope);
    if (scope === undefined) continue;
    for (const call of budgetCallsWithin(scope, spec.callee)) {
      const argument = budgetArgumentNode(call, spec.argument);
      resolved.push({
        site: spec.site,
        line: call.getStartLineNumber(),
        argument: argument === undefined ? '<absent>' : excerptOf(argument),
      });
    }
  }
  return resolved;
}

function describeBudgetScope(scope: BudgetScope): string {
  return scope.kind === 'worker-server-fixture-body' ? 'workerServer fixture body' : scope.name;
}

function budgetScopes(): BudgetScope[] {
  const byName = new Map<string, BudgetScope>();
  for (const spec of BUDGET_WIRING_SITES) byName.set(describeBudgetScope(spec.scope), spec.scope);
  return [...byName.values()];
}

function budgetArgumentExpressions(call: CallExpression): Node[] {
  const expressions: Node[] = [];
  const collect = (node: Node): void => {
    expressions.push(node);
    if (!node.isKind(SyntaxKind.ObjectLiteralExpression)) return;
    for (const property of node.getProperties()) {
      if (!property.isKind(SyntaxKind.PropertyAssignment)) continue;
      const initializer = property.getInitializer();
      if (initializer !== undefined) collect(initializer);
    }
  };
  for (const argument of call.getArguments()) collect(argument);
  return expressions;
}

interface BudgetScopeBound {
  scope: string;
  callee: string;
  line: number;
  argument: string;
  literals: number[];
}

interface BudgetScopeScan {
  freeLiterals: BudgetScopeBound[];
  reserveKeys: string[];
  missingScopes: string[];
  visitedCalls: number;
}

function scanBudgetScopeBounds(source: string): BudgetScopeScan {
  const sourceFile = parseBudgetSource(source);
  const aliases = reservesAliases(sourceFile);
  const freeLiterals: BudgetScopeBound[] = [];
  const reserveKeys = new Set<string>();
  const missingScopes: string[] = [];
  let visitedCalls = 0;

  for (const scope of budgetScopes()) {
    const node = budgetScopeNode(sourceFile, scope);
    if (node === undefined) {
      missingScopes.push(describeBudgetScope(scope));
      continue;
    }
    for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      visitedCalls += 1;
      for (const expression of budgetArgumentExpressions(call)) {
        const use = resolveBudgetUse(expression, sourceFile, aliases);
        for (const key of use.reserveKeys) reserveKeys.add(key);
        if (use.literals.length === 0) continue;
        freeLiterals.push({
          scope: describeBudgetScope(scope),
          callee: calleeName(call),
          line: call.getStartLineNumber(),
          argument: excerptOf(expression),
          literals: use.literals,
        });
      }
    }
  }

  return {
    freeLiterals,
    reserveKeys: [...reserveKeys].sort(),
    missingScopes,
    visitedCalls,
  };
}

const BUDGET_ENFORCEMENT_CALLEES = [
  'openBudgetPhase',
  'spendOnBudgetPhase',
  'refuseStarvedBudgetSlot',
  'reportBudgetOverrun',
  'budgetPhaseOverrunMessage',
  'warn',
] as const;

function budgetEnforcementCounts(
  source: string,
  scope: BudgetScope = { kind: 'worker-server-fixture-body' },
): Record<string, number> {
  const sourceFile = parseBudgetSource(source);
  const body = budgetScopeNode(sourceFile, scope);
  if (body === undefined) return {};
  return Object.fromEntries(
    BUDGET_ENFORCEMENT_CALLEES.map((callee) => [callee, budgetCallsWithin(body, callee).length]),
  );
}

function describeFreeLiterals(bounds: readonly BudgetScopeBound[]): string[] {
  return bounds.map(
    (bound) => `${bound.scope} -> ${bound.callee}(... ${bound.argument} ...) at line ${bound.line}`,
  );
}

function findingsAt(findings: readonly BudgetWiringFinding[], site: string): BudgetWiringFinding[] {
  return findings.filter((finding) => finding.site === site);
}

function reasonsOf(findings: readonly BudgetWiringFinding[]): string[] {
  return findings.map((finding) => finding.reason);
}

let cachedFixtureSource: string | undefined;

function fixtureSource(): string {
  cachedFixtureSource ??= readFileSync(FIXTURE_SOURCE_PATH, 'utf-8');
  return cachedFixtureSource;
}

function serverProcessSource(): string {
  return readFileSync(SERVER_PROCESS_SOURCE_PATH, 'utf-8');
}

function mutatedServerProcessSource(from: string, to: string): string {
  const source = serverProcessSource();
  const mutated = source.replace(from, to);
  expect(
    mutated,
    `this control's mutation literal no longer matches ${SERVER_PROCESS_SOURCE_PATH}, so the assertion below would report the behaviour it guards as broken when what actually went stale is the literal`,
  ).not.toBe(source);
  return mutated;
}

const ROLLBACK_CALLEE = 'rollbackPreparedViteCacheDir';

function viteRollbackWiringFindings(source: string): string[] {
  const sourceFile = parseBudgetSource(source);
  const prepare = sourceFile.getFunction('prepareViteCacheDir');
  if (prepare === undefined) return ['scope-missing'];
  const clause = prepare.getFirstDescendantByKind(SyntaxKind.CatchClause);
  if (clause === undefined) return ['catch-missing'];

  const findings: string[] = [];
  const calls = budgetCallsWithin(clause, ROLLBACK_CALLEE);
  if (calls.length !== 1) {
    findings.push('rollback-not-called');
  } else {
    const bound = calls[0]?.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getName();
    const consumed =
      bound !== undefined &&
      clause
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((identifier) => identifier.getText() === bound).length > 1;
    if (!consumed) findings.push('rollback-report-unconsumed');
  }

  const caught = clause.getVariableDeclaration()?.getName();
  const thrown = clause.getFirstDescendantByKind(SyntaxKind.ThrowStatement);
  if (thrown === undefined) {
    findings.push('rollback-rethrow-missing');
  } else if (caught === undefined || thrown.getExpression()?.getText() !== caught) {
    findings.push('rollback-rethrows-other');
  }
  return findings;
}

const PLANTED_BUDGET_BLOCK = [
  `export const ${DECLARED_TOTAL_EXPORT} = 40;`,
  `export const ${DECLARED_RESERVES_EXPORT} = {`,
  `  ${API_CONFIG_RESERVE_KEY}: 1,`,
  `  ${COLLAB_SYNC_RESERVE_KEY}: 2,`,
  `  ${WARMUP_GOTO_RESERVE_KEY}: 3,`,
  `  ${WARMUP_VISIBLE_RESERVE_KEY}: 4,`,
  `  ${DEV_SERVER_REAP_RESERVE_KEY}: 5,`,
  `  ${SETUP_OVERHEAD_RESERVE_KEY}: 6,`,
  `  ${TEARDOWN_RESERVE_KEY}: 7,`,
  '} as const;',
  `export function ${RESOLVE_READINESS_EXPORT}(totalMs, reserves) {`,
  '  return totalMs - Object.values(reserves).reduce((sum, ms) => sum + ms, 0);',
  '}',
  `const DERIVED_READINESS_MS = ${RESOLVE_READINESS_EXPORT}(${DECLARED_TOTAL_EXPORT}, ${DECLARED_RESERVES_EXPORT});`,
  `export function ${RESOLVE_FIRST_LOAD_STALL_EXPORT}(navigationShareMs) {`,
  '  return navigationShareMs * 3 / 4;',
  '}',
  "const REQUIRED_FIXTURE_ENTRY_NAMES = ['test-doc.md'];",
].join('\n');

const COMPLIANT_READINESS_ARGUMENT = 'DERIVED_READINESS_MS';
const COMPLIANT_GOTO_SHARE_ARGUMENT = `${DECLARED_RESERVES_EXPORT}.${WARMUP_GOTO_RESERVE_KEY}`;
const COMPLIANT_STALL_ARGUMENT = `${RESOLVE_FIRST_LOAD_STALL_EXPORT}(${COMPLIANT_GOTO_SHARE_ARGUMENT})`;
const COMPLIANT_VISIBLE_ARGUMENT = `${DECLARED_RESERVES_EXPORT}.${WARMUP_VISIBLE_RESERVE_KEY}`;
const COMPLIANT_REAP_ARGUMENT = `proc, ${DECLARED_RESERVES_EXPORT}.${DEV_SERVER_REAP_RESERVE_KEY}`;
const COMPLIANT_API_CONFIG_ARGUMENTS = `baseURL, ${DECLARED_RESERVES_EXPORT}.${API_CONFIG_RESERVE_KEY}`;
const COMPLIANT_COLLAB_SYNC_ARGUMENTS = `port, ${DECLARED_RESERVES_EXPORT}.${COLLAB_SYNC_RESERVE_KEY}`;
const COMPLIANT_SETUP_PHASE_ARGUMENT = `${DECLARED_RESERVES_EXPORT}.${SETUP_OVERHEAD_RESERVE_KEY}`;
const COMPLIANT_TEARDOWN_PHASE_ARGUMENT = `${DECLARED_RESERVES_EXPORT}.${TEARDOWN_RESERVE_KEY}`;
const COMPLIANT_STARVATION_ELAPSED_ARGUMENT = `Date.now() - ${FIXTURE_START_IDENTIFIER}`;
const REINTRODUCED_LITERAL = '60_000';

const SIBLING_CALL_SITES = [
  'async function warmGlobalViteCache(port, proc) {',
  `  await waitForHttpReady(\`http://127.0.0.1:\${port}\`, ${REINTRODUCED_LITERAL}, proc);`,
  '  await killGracefully(proc);',
  '}',
  'async function readinessInsideATestBody(baseURL, port) {',
  `  await waitForHttpReady(baseURL, ${REINTRODUCED_LITERAL});`,
  "  await checkCollabSync(port, 10_000, '::1');",
  '}',
].join('\n');

const OUT_OF_SCOPE_PROBE_BOUND = '10_000';

const OUT_OF_SCOPE_PROBE_CALL_SITES = [
  'async function bootStressServerInsideOneTest(baseURL, port, proc) {',
  '  await Promise.race([',
  '    (async () => {',
  `      await waitForHttpReady(baseURL, ${REINTRODUCED_LITERAL});`,
  `      await checkCollabSync(port, ${OUT_OF_SCOPE_PROBE_BOUND}, '::1');`,
  '    })(),',
  '    new Promise((_, reject) => {',
  "      proc.once('error', (err) => reject(err));",
  '    }),',
  '  ]);',
  '}',
  'async function probeConfigOutsideTheFixture(baseURL) {',
  `  await checkApiConfig(baseURL, ${OUT_OF_SCOPE_PROBE_BOUND});`,
  '}',
].join('\n');

function plantedFixtureSource(overrides: {
  readinessArgument?: string;
  stallArgument?: string;
  visibleArgument?: string;
  reapArguments?: readonly [string, string];
  apiConfigArguments?: string;
  collabSyncArguments?: string;
  setupPhaseArgument?: string;
  teardownPhaseArgument?: string;
  starvationElapsedArgument?: string;
  extraReadyStatement?: string;
  extraSource?: string;
}): string {
  const readiness = overrides.readinessArgument ?? COMPLIANT_READINESS_ARGUMENT;
  const stall = overrides.stallArgument ?? COMPLIANT_STALL_ARGUMENT;
  const visible = overrides.visibleArgument ?? COMPLIANT_VISIBLE_ARGUMENT;
  const reap = overrides.reapArguments ?? [COMPLIANT_REAP_ARGUMENT, COMPLIANT_REAP_ARGUMENT];
  const apiConfig = overrides.apiConfigArguments ?? COMPLIANT_API_CONFIG_ARGUMENTS;
  const collabSync = overrides.collabSyncArguments ?? COMPLIANT_COLLAB_SYNC_ARGUMENTS;
  const setupPhase = overrides.setupPhaseArgument ?? COMPLIANT_SETUP_PHASE_ARGUMENT;
  const teardownPhase = overrides.teardownPhaseArgument ?? COMPLIANT_TEARDOWN_PHASE_ARGUMENT;
  const starvationElapsed =
    overrides.starvationElapsedArgument ?? COMPLIANT_STARVATION_ELAPSED_ARGUMENT;
  return [
    PLANTED_BUDGET_BLOCK,
    '',
    'async function waitForServerReady(baseURL, port, proc) {',
    `  await waitForHttpReady(baseURL, ${readiness}, proc);`,
    `  await checkApiConfig(${apiConfig});`,
    `  await checkCollabSync(${collabSync});`,
    ...(overrides.extraReadyStatement === undefined ? [] : [`  ${overrides.extraReadyStatement}`]),
    '}',
    '',
    'async function warmupAppFirstLoad(browser, baseURL, overhead) {',
    '  const context = await spendOnBudgetPhase(overhead, () => browser.newContext());',
    '  const page = await spendOnBudgetPhase(overhead, () => context.newPage());',
    `  await gotoWhileLoadProgresses(page, \`\${baseURL}/\`, ${stall});`,
    '  await page',
    "    .getByRole('treeitem', { name: REQUIRED_FIXTURE_ENTRY_NAMES[0], exact: true })",
    `    .waitFor({ state: 'visible', timeout: ${visible} });`,
    '  await spendOnBudgetPhase(overhead, () => context.close());',
    '}',
    '',
    'export const test = base.extend({',
    '  workerServer: [',
    '    async ({ browser }, use) => {',
    '      const fixtureStartedAt = Date.now();',
    `      const setupOverhead = openBudgetPhase('setup overhead', ${setupPhase});`,
    '      try {',
    '        await waitForServerReady(baseURL, port, proc);',
    '        await warmupAppFirstLoad(browser, baseURL, setupOverhead);',
    `        refuseStarvedBudgetSlot(setupOverhead, ${starvationElapsed}, residue);`,
    '      } catch (err) {',
    `        await killGracefully(${reap[0]});`,
    '        throw err;',
    '      }',
    '      await use({ port, baseURL, contentDir });',
    `      const teardown = openBudgetPhase('teardown', ${teardownPhase});`,
    `      await killGracefully(${reap[1]});`,
    '      await spendOnBudgetPhase(teardown, () => removeAllDuringTeardown(contentDir));',
    '    },',
    `    { scope: 'worker', timeout: ${DECLARED_TOTAL_EXPORT} },`,
    '  ],',
    '});',
    overrides.extraSource ?? '',
  ].join('\n');
}

describe('worker-server fixture budget wiring', () => {
  test('the readiness bound the fixture hands its dev-server wait is the derived share, not a free literal', () => {
    const source = fixtureSource();
    expect(source.length, `${FIXTURE_SOURCE_PATH} must be readable`).toBeGreaterThan(0);

    const resolved = resolvedBudgetCalls(source).filter(
      (call) => call.site === READINESS_BOUND_SITE,
    );
    expect(
      resolved.length,
      'the readiness wait inside waitForServerReady was not found, so nothing about its bound was checked',
    ).toBe(1);

    expect(
      findingsAt(scanBudgetWiring(source), READINESS_BOUND_SITE),
      `the fixture's readiness wait must be handed the share ${RESOLVE_READINESS_EXPORT} derives from ${DECLARED_TOTAL_EXPORT}, so the manifest cannot disagree with what the call site spends. Passing a number written at the call site re-opens the defect while every other budget assertion stays green`,
    ).toEqual([]);
  });

  test('the warmup legs spend the bounds the manifest declares for them', () => {
    const source = fixtureSource();
    const findings = scanBudgetWiring(source);
    const resolved = resolvedBudgetCalls(source);

    expect(
      resolved.filter((call) => call.site === WARMUP_NAVIGATION_STALL_SITE).length,
      "the warmup's progress-bounded navigation was not found, so nothing about its stall window was checked",
    ).toBe(1);
    expect(
      resolved.filter((call) => call.site === WARMUP_VISIBLE_SITE).length,
      'the warmup visibility wait was not found, so nothing about its bound was checked',
    ).toBe(1);

    expect(
      findingsAt(findings, WARMUP_NAVIGATION_STALL_SITE),
      `the warmup navigation must spend the stall window ${RESOLVE_FIRST_LOAD_STALL_EXPORT} derives from ${DECLARED_RESERVES_EXPORT}.${WARMUP_GOTO_RESERVE_KEY} and carry no Playwright total of its own. Playwright supplies its own default when a bound is dropped, so a window written at the call site, a share passed undivided or a dropped argument would leave the reserve table describing a bound the fixture does not spend`,
    ).toEqual([]);
    expect(
      findingsAt(findings, WARMUP_VISIBLE_SITE),
      `the warmup visibility wait must spend ${DECLARED_RESERVES_EXPORT}.${WARMUP_VISIBLE_RESERVE_KEY}, for the same reason as the navigation leg`,
    ).toEqual([]);
  });

  test('both reap call sites spend the declared reap reserve rather than the helper default', () => {
    const source = fixtureSource();
    const resolved = resolvedBudgetCalls(source).filter(
      (call) => call.site === DEV_SERVER_REAP_SITE,
    );
    expect(
      resolved.length,
      'the fixture body must reap its spawned dev server on both the failed-setup path and the teardown path',
    ).toBe(2);

    expect(
      findingsAt(scanBudgetWiring(source), DEV_SERVER_REAP_SITE),
      `both reap calls must spend ${DECLARED_RESERVES_EXPORT}.${DEV_SERVER_REAP_RESERVE_KEY}. killGracefully keeps its own default for the globalSetup caller that has no enclosing fixture slot, so an omitted argument here silently reverts the fixture's reap bound and compiles clean`,
    ).toEqual([]);
  });

  test('the refusal is pinned to an elapsed-since-fixture-start argument, so swapping in one phase spend reds', () => {
    expect(
      findingsAt(scanBudgetWiring(fixtureSource()), STARVATION_ELAPSED_SITE),
      'the shipped refusal must already satisfy the pin, or the control below proves nothing',
    ).toEqual([]);

    expect(
      reasonsOf(
        findingsAt(
          scanBudgetWiring(
            plantedFixtureSource({ starvationElapsedArgument: 'setupOverhead.spentMs' }),
          ),
          STARVATION_ELAPSED_SITE,
        ),
      ),
      'substituting a single phase spend for the elapsed expression turns the cumulative predicate back into the per-phase one this commit replaced, which is the shape a refactor or a merge resolution produces, and every other assertion in this file stays green through it',
    ).toEqual(['unlinked']);

    expect(
      reasonsOf(
        findingsAt(
          scanBudgetWiring(
            plantedFixtureSource({
              starvationElapsedArgument: `Date.now() - ${FIXTURE_START_IDENTIFIER}`,
            }),
          ),
          STARVATION_ELAPSED_SITE,
        ),
      ),
      'the must-not-fire control: the compliant expression stays green',
    ).toEqual([]);
  });

  test('a drain failure is reported beside the setup failure, and the composition that does it is pinned', () => {
    expect(
      drainGuardFindings(fixtureSource()),
      'the shipped fixture must already guard the drain and compose all four parts, or the controls below prove nothing',
    ).toEqual([]);

    expect(
      drainGuardFindings(
        mutatedFixtureSource(
          `        let drainFailure: string | undefined;
        try {
          await runTeardownPhases(...[...releaseSetupResources].reverse());
        } catch (cleanupErr) {
          drainFailure = \`--- cleanup after this failure did not complete: \${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)} ---\`;
        }`,
          '        await runTeardownPhases(...[...releaseSetupResources].reverse());',
        ),
      ),
      'reverting to the unguarded drain lets a cleanup error replace the setup failure and the log tail, which is the diagnostic loss the prior round raised',
    ).toContain('drain-unguarded');

    expect(
      drainGuardFindings(
        mutatedFixtureSource(
          `\`\${reason}\${borrowed === undefined ? '' : \`\\n\${borrowed}\`}\${drainFailure === undefined ? '' : \`\\n\${drainFailure}\`}\\n\${tail}\``,
          `\`\${drainFailure}\``,
        ),
      ),
      'composing the throw so the drain failure replaces the other three parts must red, since that is the substitution rather than the omission',
    ).toEqual(expect.arrayContaining(['drain-drops-reason', 'drain-drops-tail']));
  });

  test('the setup non-result is declared once, after the drain and unconditionally on the rethrow path', () => {
    expect(
      setupNonResultDeclarationFindings(fixtureSource()),
      'the shipped fixture must declare the setup non-result exactly once, after the drain and as a statement beside the rethrow, or the controls below prove nothing',
    ).toEqual([]);

    const undeclared = mutatedFixtureSource(SETUP_NON_RESULT_DECLARATION, '');
    const declaredBeforeDrain = undeclared.replace(
      DRAIN_BLOCK_OPENER,
      `${SETUP_NON_RESULT_DECLARATION}${DRAIN_BLOCK_OPENER}`,
    );
    expect(
      declaredBeforeDrain,
      `this control's drain anchor no longer matches ${FIXTURE_SOURCE_PATH}, so the assertion below would report the ordering it guards as broken when what actually went stale is the anchor`,
    ).not.toBe(undeclared);
    expect(
      setupNonResultDeclarationFindings(declaredBeforeDrain),
      'declaring before the drain lets base.info() throw where no TestInfo is current, once Playwright has already timed out the fixture slot, and skip the reap of the detached dev server and the removal of its dirs',
    ).toEqual(['declaration-before-drain']);

    expect(
      setupNonResultDeclarationFindings(
        mutatedFixtureSource(
          SETUP_NON_RESULT_DECLARATION,
          '        if (openedServerLog !== undefined) declareSetupNonResult(base.info(), reason);\n',
        ),
      ),
      'a declaration some setup branches skip leaves those failures declared as executed assertion failures while the readiness branch the runtime check drives stays green',
    ).toEqual(['declaration-off-the-rethrow-path']);
  });

  test('the seed-copy catch calls the rollback and still re-raises the copy failure itself', () => {
    expect(
      viteRollbackWiringFindings(serverProcessSource()),
      'the shipped catch must already satisfy the pin, or the controls below prove nothing',
    ).toEqual([]);

    expect(
      viteRollbackWiringFindings(
        mutatedServerProcessSource(
          `      const rollbackFailure = rollbackPreparedViteCacheDir(dir);
      if (rollbackFailure !== undefined) console.warn(`,
          `      if (undefined !== undefined) console.warn(`,
        ),
      ),
      'deleting the rollback call from the catch compiles and leaves every other test green, so the scan has to reach this module rather than stopping at fixtures.ts',
    ).toContain('rollback-not-called');

    expect(
      viteRollbackWiringFindings(
        mutatedServerProcessSource(
          `      const rollbackFailure = rollbackPreparedViteCacheDir(dir);
      if (rollbackFailure !== undefined) console.warn(\`[e2e teardown] \${rollbackFailure}\`);`,
          '      rollbackPreparedViteCacheDir(dir);',
        ),
      ),
      'keeping the call but discarding what it returns reads as dead-code cleanup and silences both strings the helper exists to produce, so requiring the callee to appear is not enough',
    ).toContain('rollback-report-unconsumed');

    expect(
      viteRollbackWiringFindings(
        mutatedServerProcessSource(
          '      throw err;\n',
          '      throw new Error(rollbackFailure);\n',
        ),
      ),
      'throwing the rollback failure in place of the copy failure is the displacement this commit closed, and it must red here',
    ).toContain('rollback-rethrows-other');
  });

  test('every bound the fixture spends resolves to a reserve the live manifest declares', async () => {
    const table = await expectDeclaredReserveTable(await declaredReserves());

    const resolved = resolvedBudgetCalls(fixtureSource());
    expect(
      resolved.map((call) => call.site).sort(),
      'the wiring scan no longer resolves every pinned budget consumption point in the fixture, so the sites it reports nothing about are unchecked rather than compliant',
    ).toEqual(
      [
        API_CONFIG_PROBE_SITE,
        COLLAB_SYNC_PROBE_SITE,
        DEV_SERVER_REAP_SITE,
        DEV_SERVER_REAP_SITE,
        READINESS_BOUND_SITE,
        STARVATION_ELAPSED_SITE,
        WARMUP_NAVIGATION_STALL_SITE,
        WARMUP_VISIBLE_SITE,
      ].sort(),
    );

    for (const spec of BUDGET_WIRING_SITES) {
      const key =
        spec.requires.kind === 'reserve' || spec.requires.kind === 'derived'
          ? spec.requires.key
          : undefined;
      if (key === undefined) continue;
      expect(
        table[key],
        `${spec.site} spends the reserve ${key}, which the live ${DECLARED_RESERVES_EXPORT} does not declare`,
      ).toBeGreaterThan(0);
    }

    const exports = await fixtureExports();
    for (const spec of BUDGET_WIRING_SITES) {
      if (spec.requires.kind !== 'derived') continue;
      expect(
        typeof exports[spec.requires.root],
        `${spec.site} derives its bound through ${spec.requires.root}: a site whose bound is derived through a root the live manifest no longer exports is pinned against nothing`,
      ).toBe('function');
    }

    const scan = scanBudgetScopeBounds(fixtureSource());
    expect(
      scan.missingScopes,
      'a budget scope the fixture no longer declares is unscanned rather than compliant',
    ).toEqual([]);
    expect(
      scan.visitedCalls,
      'the scan considered fewer calls than the pinned sites alone, so it read a source it did not parse',
    ).toBeGreaterThan(resolved.length);

    expect(
      describeFreeLiterals(scan.freeLiterals),
      `every number reaching a call argument inside ${budgetScopes().map(describeBudgetScope).join(', ')} must trace to ${DECLARED_RESERVES_EXPORT} or ${RESOLVE_READINESS_EXPORT}. The scan discovers those calls rather than reading a list of them, so a bound added later at a call site no pinned site covers reds here instead of shipping green. It is deliberately broad: a number in a budget scope that is not a bound costs one rewrite, while a bound written at the call site is the defect this manifest exists to remove`,
    ).toEqual([]);

    expect(
      scan.reserveKeys,
      `every key ${DECLARED_RESERVES_EXPORT} declares must be spent by a call inside a budget scope, or the reserve shrinks the readiness residual while bounding nothing`,
    ).toEqual(Object.keys(table).sort());
  });

  test('the budget-scope scan discovers a bound no pinned site covers, and leaves bounds outside those scopes alone', () => {
    const UNPINNED_BOUND_CALLEE = 'settleSeededPages';
    const compliant = plantedFixtureSource({});
    const compliantScan = scanBudgetScopeBounds(compliant);
    expect(compliantScan.missingScopes).toEqual([]);
    expect(compliantScan.visitedCalls).toBeGreaterThan(0);
    expect(
      describeFreeLiterals(compliantScan.freeLiterals),
      'the scan reported a free literal against a compliant source; the element access into REQUIRED_FIXTURE_ENTRY_NAMES is an index, not a bound, and a rule that reds it pins the spelling rather than the value',
    ).toEqual([]);

    const freeLiteral = scanBudgetScopeBounds(
      plantedFixtureSource({
        extraReadyStatement: `await ${UNPINNED_BOUND_CALLEE}(baseURL, 30_000);`,
      }),
    );
    expect(freeLiteral.freeLiterals.map((bound) => bound.callee)).toEqual([UNPINNED_BOUND_CALLEE]);
    expect(freeLiteral.freeLiterals[0]?.literals).toEqual([30_000]);
    expect(
      reasonsOf(
        scanBudgetWiring(
          plantedFixtureSource({
            extraReadyStatement: `await ${UNPINNED_BOUND_CALLEE}(baseURL, 30_000);`,
          }),
        ),
      ),
      'the per-site scan is silent on a bound at a call site it does not enumerate, which is exactly the gap the discovering scan closes',
    ).toEqual([]);

    const launderedLiteral = scanBudgetScopeBounds(
      plantedFixtureSource({
        extraReadyStatement: `await ${UNPINNED_BOUND_CALLEE}(baseURL, SETTLE_MS);`,
        extraSource: 'const SETTLE_MS = 30_000;',
      }),
    );
    expect(launderedLiteral.freeLiterals.map((bound) => bound.callee)).toEqual([
      UNPINNED_BOUND_CALLEE,
    ]);

    const optionLiteral = scanBudgetScopeBounds(
      plantedFixtureSource({
        extraReadyStatement: `await ${UNPINNED_BOUND_CALLEE}(baseURL, { timeout: 30_000 });`,
      }),
    );
    expect(optionLiteral.freeLiterals.map((bound) => bound.callee)).toEqual([
      UNPINNED_BOUND_CALLEE,
    ]);

    const spendsAReserve = scanBudgetScopeBounds(
      plantedFixtureSource({
        extraReadyStatement: `await ${UNPINNED_BOUND_CALLEE}(baseURL, ${DECLARED_RESERVES_EXPORT}.${COLLAB_SYNC_RESERVE_KEY});`,
      }),
    );
    expect(
      describeFreeLiterals(spendsAReserve.freeLiterals),
      'a bound that traces to the declared reserves is compliant wherever it is spent, so a rule that reds it would force every new call site into the enumerated list',
    ).toEqual([]);

    const outsideTheScopes = scanBudgetScopeBounds(
      plantedFixtureSource({
        extraSource: [
          'async function settleOutsideTheFixture(baseURL) {',
          `  await ${UNPINNED_BOUND_CALLEE}(baseURL, 30_000);`,
          '}',
          SIBLING_CALL_SITES,
          OUT_OF_SCOPE_PROBE_CALL_SITES,
        ].join('\n'),
      }),
    );
    expect(
      describeFreeLiterals(outsideTheScopes.freeLiterals),
      'the scan reported a bound outside the three budget scopes. The globalSetup warm-cache call, the two in-test readiness waits and the out-of-fixture probes are bounded by enclosures this budget says nothing about',
    ).toEqual([]);
  });

  test('the budget-scope scan reports a declared reserve that no call inside the scopes spends', () => {
    const compliant = scanBudgetScopeBounds(plantedFixtureSource({}));
    expect(compliant.reserveKeys).toEqual(
      [
        API_CONFIG_RESERVE_KEY,
        COLLAB_SYNC_RESERVE_KEY,
        DEV_SERVER_REAP_RESERVE_KEY,
        SETUP_OVERHEAD_RESERVE_KEY,
        TEARDOWN_RESERVE_KEY,
        WARMUP_GOTO_RESERVE_KEY,
        WARMUP_VISIBLE_RESERVE_KEY,
      ].sort(),
    );

    const withoutTeardownPhase = scanBudgetScopeBounds(
      plantedFixtureSource({}).replace(
        `      const teardown = openBudgetPhase('teardown', ${COMPLIANT_TEARDOWN_PHASE_ARGUMENT});`,
        "      const teardown = openBudgetPhase('teardown', 15_000);",
      ),
    );
    expect(
      withoutTeardownPhase.reserveKeys,
      'dropping the teardown phase back to a literal must leave the teardown reserve spent by nothing, which is what the live-manifest assertion compares against',
    ).not.toContain(TEARDOWN_RESERVE_KEY);
    expect(withoutTeardownPhase.freeLiterals.map((bound) => bound.callee)).toEqual([
      'openBudgetPhase',
    ]);
  });

  test('the wiring rule fires on a re-introduced literal and leaves the sibling call sites alone', () => {
    expect(reasonsOf(scanBudgetWiring(plantedFixtureSource({})))).toEqual([]);

    const literalReadiness = scanBudgetWiring(
      plantedFixtureSource({ readinessArgument: REINTRODUCED_LITERAL }),
    );
    expect(reasonsOf(literalReadiness)).toEqual(['free-literal']);
    expect(literalReadiness[0]?.site).toBe(READINESS_BOUND_SITE);

    const launderedLiteral = scanBudgetWiring(
      plantedFixtureSource({
        readinessArgument: 'REINTRODUCED_READINESS_MS',
        extraSource: `const REINTRODUCED_READINESS_MS = ${REINTRODUCED_LITERAL};`,
      }),
    );
    expect(reasonsOf(launderedLiteral)).toEqual(['free-literal']);

    const bareReap = scanBudgetWiring(
      plantedFixtureSource({ reapArguments: ['proc', COMPLIANT_REAP_ARGUMENT] }),
    );
    expect(reasonsOf(bareReap)).toEqual(['argument-missing']);
    expect(bareReap[0]?.site).toBe(DEV_SERVER_REAP_SITE);

    const swappedReserve = scanBudgetWiring(
      plantedFixtureSource({
        stallArgument: `${RESOLVE_FIRST_LOAD_STALL_EXPORT}(${COMPLIANT_VISIBLE_ARGUMENT})`,
      }),
    );
    expect(reasonsOf(swappedReserve)).toEqual(['wrong-reserve']);
    expect(swappedReserve[0]?.site).toBe(WARMUP_NAVIGATION_STALL_SITE);

    const droppedStallArgument = scanBudgetWiring(
      replacedOnce(plantedFixtureSource({}), `, ${COMPLIANT_STALL_ARGUMENT}`, ''),
    );
    expect(reasonsOf(droppedStallArgument)).toEqual(['argument-missing']);
    expect(droppedStallArgument[0]?.site).toBe(WARMUP_NAVIGATION_STALL_SITE);

    const undividedShare = scanBudgetWiring(
      plantedFixtureSource({ stallArgument: COMPLIANT_GOTO_SHARE_ARGUMENT }),
    );
    expect(
      reasonsOf(undividedShare),
      'handing the progress-bounded navigation the whole navigation share makes its stall window as long as the fixed total it replaced, so a hung load is refused no sooner than before',
    ).toEqual(['unlinked']);
    expect(undividedShare[0]?.site).toBe(WARMUP_NAVIGATION_STALL_SITE);

    const literalThroughResolver = scanBudgetWiring(
      plantedFixtureSource({ stallArgument: `${RESOLVE_FIRST_LOAD_STALL_EXPORT}(30_000)` }),
    );
    expect(
      reasonsOf(literalThroughResolver),
      'a number handed to the resolver is a stall window written at the call site, however the call is spelled',
    ).toEqual(['free-literal']);
    expect(literalThroughResolver[0]?.site).toBe(WARMUP_NAVIGATION_STALL_SITE);

    const literalStallWindow = scanBudgetWiring(plantedFixtureSource({ stallArgument: '30_000' }));
    expect(reasonsOf(literalStallWindow)).toEqual(['free-literal']);
    expect(literalStallWindow[0]?.site).toBe(WARMUP_NAVIGATION_STALL_SITE);

    const thirdReapCall = scanBudgetWiring(
      plantedFixtureSource({}).replace(
        `      await killGracefully(${COMPLIANT_REAP_ARGUMENT});`,
        `      await killGracefully(${COMPLIANT_REAP_ARGUMENT});\n      await killGracefully(proc);`,
      ),
    );
    expect(reasonsOf(thirdReapCall)).toEqual(['call-count', 'argument-missing']);

    expect(
      reasonsOf(scanBudgetWiring(plantedFixtureSource({ extraSource: SIBLING_CALL_SITES }))),
      'the rule reported a finding against a readiness wait or a reap call outside the workerServer fixture path. The globalSetup warm-cache call and the two in-test readiness waits are bounded by enclosures this budget says nothing about, and a rule that reds them is over-broad',
    ).toEqual([]);

    expect(
      reasonsOf(
        scanBudgetWiring(
          plantedFixtureSource({
            stallArgument: `${RESOLVE_FIRST_LOAD_STALL_EXPORT}(RESERVE_ALIAS.${WARMUP_GOTO_RESERVE_KEY})`,
            extraSource: `const RESERVE_ALIAS = ${DECLARED_RESERVES_EXPORT};`,
          }),
        ),
      ),
      'the rule reported a finding against a reserve reached through a module-local alias, so it pins the spelling that happened to exist rather than the value the call site spends',
    ).toEqual([]);

    const bareApiConfigBound = scanBudgetWiring(
      plantedFixtureSource({ apiConfigArguments: 'baseURL' }),
    );
    expect(reasonsOf(bareApiConfigBound)).toEqual(['argument-missing']);
    expect(bareApiConfigBound[0]?.site).toBe(API_CONFIG_PROBE_SITE);

    const literalApiConfigBound = scanBudgetWiring(
      plantedFixtureSource({ apiConfigArguments: `baseURL, ${OUT_OF_SCOPE_PROBE_BOUND}` }),
    );
    expect(reasonsOf(literalApiConfigBound)).toEqual(['free-literal']);
    expect(literalApiConfigBound[0]?.site).toBe(API_CONFIG_PROBE_SITE);

    const swappedApiConfigReserve = scanBudgetWiring(
      plantedFixtureSource({
        apiConfigArguments: `baseURL, ${DECLARED_RESERVES_EXPORT}.${COLLAB_SYNC_RESERVE_KEY}`,
      }),
    );
    expect(reasonsOf(swappedApiConfigReserve)).toEqual(['wrong-reserve']);
    expect(swappedApiConfigReserve[0]?.site).toBe(API_CONFIG_PROBE_SITE);

    const bareCollabSyncBound = scanBudgetWiring(
      plantedFixtureSource({ collabSyncArguments: 'port' }),
    );
    expect(reasonsOf(bareCollabSyncBound)).toEqual(['argument-missing']);
    expect(bareCollabSyncBound[0]?.site).toBe(COLLAB_SYNC_PROBE_SITE);

    const literalCollabSyncBound = scanBudgetWiring(
      plantedFixtureSource({
        collabSyncArguments: `port, ${OUT_OF_SCOPE_PROBE_BOUND}, '::1'`,
      }),
    );
    expect(
      reasonsOf(literalCollabSyncBound),
      'a bound written at the probe call site must red even when the number it spells happens to equal the reserve it replaced, because the next edit to the table moves the reserve and leaves the call site behind',
    ).toEqual(['free-literal']);
    expect(literalCollabSyncBound[0]?.site).toBe(COLLAB_SYNC_PROBE_SITE);

    const swappedCollabSyncReserve = scanBudgetWiring(
      plantedFixtureSource({
        collabSyncArguments: `port, ${DECLARED_RESERVES_EXPORT}.${API_CONFIG_RESERVE_KEY}`,
      }),
    );
    expect(reasonsOf(swappedCollabSyncReserve)).toEqual(['wrong-reserve']);
    expect(swappedCollabSyncReserve[0]?.site).toBe(COLLAB_SYNC_PROBE_SITE);

    expect(
      reasonsOf(
        scanBudgetWiring(plantedFixtureSource({ extraSource: OUT_OF_SCOPE_PROBE_CALL_SITES })),
      ),
      'the rule reported a finding against a probe call outside waitForServerReady. checkCollabSync is exported from server-process.ts and the two stress specs call it from their own test bodies with a bound the per-test slot governs, not this budget, so a rule that keys off the callee name instead of the enclosing function reds code it does not govern',
    ).toEqual([]);

    const strippedBudget = scanBudgetWiring(
      plantedFixtureSource({}).replace('async function waitForServerReady', 'async function gone'),
    );
    expect(reasonsOf(strippedBudget)).toEqual(['scope-missing', 'scope-missing', 'scope-missing']);
    expect(
      strippedBudget.map((finding) => finding.site).sort(),
      'losing waitForServerReady must be reported once per pinned site inside it, so a scope that silently stops existing cannot read as three compliant call sites',
    ).toEqual([API_CONFIG_PROBE_SITE, COLLAB_SYNC_PROBE_SITE, READINESS_BOUND_SITE].sort());
  });

  test('both readiness probes spend the reserves the manifest declares for them', () => {
    const source = fixtureSource();
    const findings = scanBudgetWiring(source);
    const resolved = resolvedBudgetCalls(source);

    expect(
      resolved.filter((call) => call.site === API_CONFIG_PROBE_SITE).length,
      'the /api/config probe inside waitForServerReady was not found, so nothing about its bound was checked',
    ).toBe(1);
    expect(
      resolved.filter((call) => call.site === COLLAB_SYNC_PROBE_SITE).length,
      'the collab-sync probe inside waitForServerReady was not found, so nothing about its bound was checked',
    ).toBe(1);

    expect(
      findingsAt(findings, API_CONFIG_PROBE_SITE),
      `the /api/config probe must spend ${DECLARED_RESERVES_EXPORT}.${API_CONFIG_RESERVE_KEY}. Dropping the argument reaches no typecheck — the Playwright runner transforms this file without checking its types and the package program does not include it — so the reserve table would silently over-state what the fixture spends while every other budget assertion stayed green`,
    ).toEqual([]);
    expect(
      findingsAt(findings, COLLAB_SYNC_PROBE_SITE),
      `the collab-sync probe must spend ${DECLARED_RESERVES_EXPORT}.${COLLAB_SYNC_RESERVE_KEY}, for the same reason as the /api/config probe. Its two stress-spec callers pass a bound of their own, so a bound omitted here is invisible to them as well`,
    ).toEqual([]);
  });

  test('the warmup wiring scan fires on every way the fixture body can bypass the warmup, and stays quiet on navigations it does not govern', () => {
    const compliant = plantedWarmupWiringSource();
    expect(
      warmupWiringFindings(compliant),
      'the must-not-fire control: an exported warmup that the fixture body awaits exactly once, whose own navigation lives inside the warmup, is the shape every mutation below departs from',
    ).toEqual([]);

    expect(
      warmupWiringFindings(plantedFixtureSource({})),
      'a warmup the module does not export is one the liveness tests cannot drive, so the path they prove progress-bounded would not be the path the fixture spends',
    ).toEqual(['warmup-not-exported']);

    expect(
      warmupWiringFindings(
        replacedOnce(compliant, PLANTED_WARMUP_CALL, inlineBareNavigation(PLANTED_BASE_URL)),
      ),
      'inlining a bare page.goto where the warmup call was keeps a fixed-total navigation in the fixture while every liveness test stays green against a warmup nothing calls',
    ).toEqual(['warmup-call-count', 'navigation-bypasses-warmup']);

    expect(
      warmupWiringFindings(
        replacedOnce(
          compliant,
          PLANTED_WARMUP_CALL,
          `${PLANTED_WARMUP_CALL}\n${bareNavigation(PLANTED_BASE_URL)}`,
        ),
      ),
      'the adjacent must-fire: a second navigation beside a warmup call that is still present must red on its own, not only when the call goes missing',
    ).toEqual(['navigation-bypasses-warmup']);

    expect(
      warmupWiringFindings(
        replacedOnce(
          compliant,
          PLANTED_WARMUP_CALL,
          PLANTED_WARMUP_CALL.replace('await ', 'void '),
        ),
      ),
      'a warmup the setup does not await lets the fixture hand tests a server whose first load has not finished, and turns a refused load into an unhandled rejection',
    ).toEqual(['warmup-not-awaited']);

    expect(
      warmupWiringFindings(
        replacedOnce(
          compliant,
          PLANTED_WARMUP_CALL,
          `${PLANTED_WARMUP_CALL}\n${PLANTED_WARMUP_CALL}`,
        ),
      ),
    ).toEqual(['warmup-call-count']);

    expect(
      warmupWiringFindings(
        replacedOnce(compliant, `export ${PLANTED_WARMUP_DECLARATION}`, RENAMED_WARMUP_DECLARATION),
      ),
      'a call to a warmup the module no longer declares is named rather than read as a compliant call',
    ).toEqual(['warmup-missing']);

    expect(
      warmupWiringFindings(replacedOnce(compliant, 'workerServer: [', 'otherServer: [')),
      'losing the fixture body must be reported, or a scan that found nothing to check reads as a compliant one',
    ).toEqual(['scope-missing']);

    expect(
      warmupWiringFindings(plantedWarmupWiringSource(NAVIGATIONS_OUTSIDE_THE_FIXTURE_BODY)),
      'the adjacent must-not-fire control: a navigation inside a test body or another fixture is bounded by that test, not by this fixture, so a rule that keys off the callee name instead of the enclosing fixture body reds code it does not govern',
    ).toEqual([]);
  });

  test('the fixture runs its first load through the exported warmup the liveness tests drive, awaited once, with no navigation beside it', () => {
    expect(
      warmupWiringFindings(
        mutatedFixtureSource(LIVE_WARMUP_CALL, inlineBareNavigation(LIVE_BASE_URL)),
      ),
      'the live-drift control: the same bypass planted into the shipped fixture must red, so the scan reaches the fixture as it is spelled rather than only the planted copy',
    ).toEqual(expect.arrayContaining(['warmup-call-count', 'navigation-bypasses-warmup']));

    expect(
      warmupWiringFindings(fixtureSource()),
      `the workerServer fixture body must await ${WARMUP_FIRST_LOAD_EXPORT} exactly once and navigate nowhere else, and ${FIXTURE_MODULE} must export that same ${WARMUP_FIRST_LOAD_EXPORT}. The liveness tests prove the exported warmup refuses only a stalled first load; that proof covers the fixture only if the fixture's first load is that warmup`,
    ).toEqual([]);
  });
});

const WARMUP_FIRST_LOAD_EXPORT = 'warmupAppFirstLoad';
const REQUIRED_ENTRY_NAMES_EXPORT = 'REQUIRED_FIXTURE_ENTRY_NAMES';
const OPEN_BUDGET_PHASE_EXPORT = 'openBudgetPhase';
const WARMUP_BYPASS_NAVIGATION_CALLEE = 'goto';

const LIVE_BASE_URL = 'started.baseURL';
const LIVE_WARMUP_CALL = [
  `        await ${WARMUP_FIRST_LOAD_EXPORT}(`,
  '          browser,',
  `          ${LIVE_BASE_URL},`,
  '          setupOverhead,',
  `          ${FIXTURE_START_IDENTIFIER} + WORKER_SERVER_SETUP_STARVATION_LINE_MS,`,
  '        );',
].join('\n');
const PLANTED_BASE_URL = 'baseURL';
const PLANTED_WARMUP_CALL = `        await ${WARMUP_FIRST_LOAD_EXPORT}(browser, ${PLANTED_BASE_URL}, setupOverhead);`;
const PLANTED_WARMUP_DECLARATION = `async function ${WARMUP_FIRST_LOAD_EXPORT}(browser, baseURL, overhead) {`;
const RENAMED_WARMUP_DECLARATION =
  'export async function firstLoadOnce(browser, baseURL, overhead) {';

const NAVIGATIONS_OUTSIDE_THE_FIXTURE_BODY = [
  'async function navigateInsideATestBody(page, baseURL) {',
  `  await page.goto(\`\${baseURL}/\`, { timeout: ${REINTRODUCED_LITERAL} });`,
  '}',
  'export const sibling = base.extend({',
  '  ephemeral: async ({ page }, use) => {',
  "    await page.goto('/');",
  '    await use({});',
  '  },',
  '});',
].join('\n');

function bareNavigation(baseURLExpression: string): string {
  return `        await warmupPage.goto(\`\${${baseURLExpression}}/\`, { timeout: ${DECLARED_RESERVES_EXPORT}.${WARMUP_GOTO_RESERVE_KEY} });`;
}

function inlineBareNavigation(baseURLExpression: string): string {
  return [
    '        const warmupContext = await browser.newContext();',
    '        const warmupPage = await warmupContext.newPage();',
    bareNavigation(baseURLExpression),
  ].join('\n');
}

function replacedOnce(source: string, from: string, to: string): string {
  const replaced = source.replace(from, to);
  expect(
    replaced,
    `the planted mutation literal ${JSON.stringify(from)} no longer matches the source it mutates, so the control built on it would scan the unmutated shape`,
  ).not.toBe(source);
  return replaced;
}

function plantedWarmupWiringSource(extraSource?: string): string {
  return replacedOnce(
    plantedFixtureSource(extraSource === undefined ? {} : { extraSource }),
    PLANTED_WARMUP_DECLARATION,
    `export ${PLANTED_WARMUP_DECLARATION}`,
  );
}

function warmupWiringFindings(source: string): string[] {
  const sourceFile = parseBudgetSource(source);
  const findings: string[] = [];
  const declared = sourceFile.getFunction(WARMUP_FIRST_LOAD_EXPORT);
  if (declared === undefined) findings.push('warmup-missing');
  else if (!declared.isExported()) findings.push('warmup-not-exported');

  const body = workerServerFixtureBody(sourceFile);
  if (body === undefined) return [...findings, 'scope-missing'];

  const calls = budgetCallsWithin(body, WARMUP_FIRST_LOAD_EXPORT);
  if (calls.length !== 1) findings.push('warmup-call-count');
  if (calls.some((call) => call.getParent()?.getKind() !== SyntaxKind.AwaitExpression)) {
    findings.push('warmup-not-awaited');
  }
  if (budgetCallsWithin(body, WARMUP_BYPASS_NAVIGATION_CALLEE).length > 0) {
    findings.push('navigation-bypasses-warmup');
  }
  return findings;
}

type WarmupFirstLoad = (browser: unknown, baseURL: string, overhead: unknown) => Promise<void>;

type WarmupFirstLoadBefore = (
  browser: unknown,
  baseURL: string,
  overhead: unknown,
  deadlineAt: number,
) => Promise<void>;

interface DeclaredFirstLoadBudget {
  warmup: WarmupFirstLoad;
  warmupBefore: WarmupFirstLoadBefore;
  openPhase: (name: string, reserveMs: number) => unknown;
  totalMs: number;
  navigationReserveMs: number;
  visibleReserveMs: number;
  setupOverheadReserveMs: number;
  starvationLineMs: number;
  renderedEntryNames: readonly string[];
}

const PHASES_LEFT_AFTER_SETUP_EXPORT = 'PHASES_LEFT_AFTER_SETUP';
const REFUSE_STARVED_BUDGET_SLOT_EXPORT = 'refuseStarvedBudgetSlot';
const STARVATION_LINE_PROBE_RESIDUE = 'starvation-line probe residue';

function declaredStarvationLineMs(
  exports: Record<string, unknown>,
  table: ReserveTable,
  totalMs: number,
  withinReserve: unknown,
): number {
  const leftAfterSetup = exports[PHASES_LEFT_AFTER_SETUP_EXPORT];
  expect(
    Array.isArray(leftAfterSetup),
    `${FIXTURE_MODULE} must export ${PHASES_LEFT_AFTER_SETUP_EXPORT}, the phases whose reserves its starvation refusal holds the end of the slot for`,
  ).toBe(true);
  const unrunShares = (leftAfterSetup as readonly unknown[]).map((key) => table[String(key)]);
  expect(
    unrunShares,
    'every phase the starvation refusal protects must be a share the live reserve table declares, or the line below is drawn against nothing',
  ).not.toContain(undefined);
  const lineMs = totalMs - unrunShares.reduce<number>((sum, ms) => sum + (ms as number), 0);
  expect(
    lineMs,
    `the starvation line inside the ${totalMs}ms slot must be positive`,
  ).toBeGreaterThan(0);

  const refuse = exports[REFUSE_STARVED_BUDGET_SLOT_EXPORT];
  expect(typeof refuse, `${FIXTURE_MODULE} must export ${REFUSE_STARVED_BUDGET_SLOT_EXPORT}`).toBe(
    'function',
  );
  const refuseAt = (elapsedMs: number) => () =>
    (refuse as (phase: unknown, elapsedMs: number, residue: string) => void)(
      withinReserve,
      elapsedMs,
      STARVATION_LINE_PROBE_RESIDUE,
    );
  expect(
    refuseAt(lineMs),
    `${lineMs}ms is read here as the fixture's starvation line, so its own ${REFUSE_STARVED_BUDGET_SLOT_EXPORT} must still admit a setup that reached exactly that far`,
  ).not.toThrow();
  expect(
    refuseAt(lineMs + 1),
    `and must refuse one that reached a millisecond past it, or the line these liveness tests hold the warmup to is not the one the fixture refuses at`,
  ).toThrow(STARVATION_LINE_PROBE_RESIDUE);
  return lineMs;
}

async function declaredFirstLoadBudget(): Promise<DeclaredFirstLoadBudget> {
  const exports = await fixtureExports();
  const warmup = exports[WARMUP_FIRST_LOAD_EXPORT];
  expect(
    typeof warmup,
    `${FIXTURE_MODULE} must export ${WARMUP_FIRST_LOAD_EXPORT}, the first-load warmup its workerServer fixture runs, so the warmup's liveness is driven against a page whose progress this suite controls rather than asserted from its source text`,
  ).toBe('function');
  const openPhase = exports[OPEN_BUDGET_PHASE_EXPORT];
  expect(typeof openPhase, `${FIXTURE_MODULE} must export ${OPEN_BUDGET_PHASE_EXPORT}`).toBe(
    'function',
  );

  const table = await expectDeclaredReserveTable(await declaredReserves());
  const total = await declaredTotalMs();
  expect(typeof total, `${FIXTURE_MODULE} must export ${DECLARED_TOTAL_EXPORT}`).toBe('number');
  const navigationReserveMs = table[WARMUP_GOTO_RESERVE_KEY];
  expect(
    navigationReserveMs,
    `${DECLARED_RESERVES_EXPORT}.${WARMUP_GOTO_RESERVE_KEY} is the navigation's declared share, and a stalled first load must be refused sooner than it. A change that renames or retires that key re-aims this read at the key that now declares the navigation's share, never at the stall window itself`,
  ).toBeGreaterThan(0);
  const visibleReserveMs = table[WARMUP_VISIBLE_RESERVE_KEY];
  expect(visibleReserveMs).toBeGreaterThan(0);
  const setupOverheadReserveMs = table[SETUP_OVERHEAD_RESERVE_KEY];
  expect(setupOverheadReserveMs).toBeGreaterThan(0);

  const renderedEntryNames = exports[REQUIRED_ENTRY_NAMES_EXPORT];
  expect(
    Array.isArray(renderedEntryNames) && renderedEntryNames.length > 0,
    `${FIXTURE_MODULE} must export ${REQUIRED_ENTRY_NAMES_EXPORT}, the tree entries the warmup waits to see rendered`,
  ).toBe(true);

  const warmupBefore = warmup as WarmupFirstLoadBefore;
  const openBudgetPhase = openPhase as (name: string, reserveMs: number) => unknown;
  const starvationLineMs = declaredStarvationLineMs(
    exports,
    table,
    total as number,
    openBudgetPhase(FIRST_LOAD_PHASE_NAME, setupOverheadReserveMs as number),
  );
  return {
    warmup: (browser, baseURL, overhead) =>
      warmupBefore(browser, baseURL, overhead, Date.now() + starvationLineMs),
    warmupBefore,
    openPhase: openBudgetPhase,
    totalMs: total as number,
    navigationReserveMs: navigationReserveMs as number,
    visibleReserveMs: visibleReserveMs as number,
    setupOverheadReserveMs: setupOverheadReserveMs as number,
    starvationLineMs,
    renderedEntryNames: renderedEntryNames as readonly string[],
  };
}

const OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS = 1_481;
const PROGRESS_PAST_RESERVE_FACTOR = 2;
const FAKE_FIRST_LOAD_BASE_URL = 'http://first-load.invalid';
const FAKE_FIRST_LOAD_URL = `${FAKE_FIRST_LOAD_BASE_URL}/`;
const FIRST_LOAD_PHASE_NAME = 'setup overhead';
const FAKE_RENDERED_ROLE = 'treeitem';
const FAKE_RESPONSE_STATUS = 200;
const FAKE_REQUEST_FAILURE_TEXT = 'net::ERR_FAILED';

const FAKE_SELF_TEST_REQUESTS = 2;
const FAKE_SELF_TEST_SPACING_MS = 400;
const FAKE_SELF_TEST_BOUND_MS = 500;
const FAKE_SELF_TEST_ENTRY = 'self-test-entry';
const FAKE_SELF_TEST_UNMODELLED_MEMBER = 'waitForEvent';

const FAKE_DOCUMENT_RESOURCE_TYPE = 'document';
const FAKE_SCRIPT_RESOURCE_TYPE = 'script';

function fakeModuleUrl(navigatedUrl: string, index: number): string {
  return `${navigatedUrl}src/module-${index}.tsx`;
}

const PLANTED_UNREAL_MEMBER = 'waitForFirstLoadProgress';
const PLANTED_UNREAL_EVENT = 'requestprogress';

const FAKE_EMITTER_MEMBERS = [
  'on',
  'once',
  'off',
  'addListener',
  'removeListener',
  'removeAllListeners',
] as const;

const FAKE_MODELLED_MEMBERS = {
  Browser: ['newContext'],
  BrowserContext: ['newPage', 'pages', 'close', ...FAKE_EMITTER_MEMBERS],
  Page: [
    'goto',
    'waitForLoadState',
    'getByRole',
    'url',
    'context',
    'isClosed',
    'close',
    ...FAKE_EMITTER_MEMBERS,
  ],
  Locator: ['waitFor'],
  Request: ['url', 'method', 'resourceType', 'failure', 'response'],
  Response: ['url', 'status', 'ok', 'request'],
} as const satisfies Record<string, readonly string[]>;

type FakeOwner = keyof typeof FAKE_MODELLED_MEMBERS;

const FAKE_PAGE_EVENTS = [
  'request',
  'response',
  'requestfinished',
  'requestfailed',
  'domcontentloaded',
  'load',
  'close',
] as const;
const FAKE_CONTEXT_EVENTS = [
  'request',
  'response',
  'requestfinished',
  'requestfailed',
  'close',
] as const;
type FakePageEvent = (typeof FAKE_PAGE_EVENTS)[number];
type FakeContextEvent = (typeof FAKE_CONTEXT_EVENTS)[number];

const FAKE_NAVIGATION_STATES = ['commit', 'domcontentloaded', 'load'] as const;
const FAKE_LOAD_STATES = ['domcontentloaded', 'load'] as const;
type FakeNavigationState = (typeof FAKE_NAVIGATION_STATES)[number];

type FakeListener = (payload: unknown) => void;

interface FakeEmitter<Event extends string> {
  on(event: Event, listener: FakeListener): unknown;
  off(event: Event, listener: FakeListener): unknown;
}

interface FakeWaitOptions {
  timeout?: unknown;
  waitUntil?: unknown;
  state?: unknown;
}

interface FakePage extends FakeEmitter<FakePageEvent> {
  goto(url: string, options?: FakeWaitOptions): Promise<unknown>;
  getByRole(
    role: string,
    options?: { name?: unknown },
  ): { waitFor(options?: FakeWaitOptions): Promise<void> };
  close(): Promise<void>;
}

interface FakeContext extends FakeEmitter<FakeContextEvent> {
  newPage(): Promise<FakePage>;
  close(): Promise<void>;
}

interface FakeBrowser {
  newContext(options?: unknown): Promise<FakeContext>;
}

type RecordedRequestTiming = readonly [issuedAtMs: number, settledAtMs: number];

interface FirstLoadTimeline {
  loadAtMs: number;
  document: RecordedRequestTiming;
  requests: readonly RecordedRequestTiming[];
}

interface SpacedFirstLoadScript {
  requests: number;
  completionSpacingMs: number;
  completing: number;
  failing?: number;
  timeline?: never;
}

interface RecordedFirstLoadScript {
  timeline: FirstLoadTimeline;
  requests?: never;
  completionSpacingMs?: never;
  completing?: never;
  failing?: never;
}

type FirstLoadScript = SpacedFirstLoadScript | RecordedFirstLoadScript;

interface FirstLoadRecord {
  navigations: string[];
  requestsIssued: number;
  requestsCompleted: number;
  requestsFailed: number;
  lastProgressAt: number | undefined;
  loadedAt: number | undefined;
  visibleWaits: string[];
  contextsOpened: number;
  contextsClosed: number;
  listeningAtGoto: string[][];
  listeningAtVisibleWait: string[][];
  listeningAtContextClose: string[][];
  timersBeyondPagesAtVisibleWait: Array<number | undefined>;
}

interface FakeRequestPair {
  url: string;
  resourceType: string;
  completed: boolean;
  failed: boolean;
  request: unknown;
  response: unknown;
}

interface FakeRequestSnapshot {
  url: string;
  resourceType: string;
  completed: boolean;
}

interface FakePageProbe {
  listening(): string[];
  pendingTimers(): number;
  requests(): FakeRequestSnapshot[];
}

interface FakeProbes {
  contexts: FakeContext[];
  pages: FakePageProbe[];
}

interface FirstLoadObserver {
  contexts: readonly FakeContext[];
  listening(): string[][];
  timersBeyondPages(): number;
  requests(): FakeRequestSnapshot[];
  held(): string[];
  releaseHeld(): void;
}

interface FakeHolds {
  newContext?: 'rejected-when-released' | 'handed-back-when-released';
  newPage?: true;
  contextClose?: true;
}

const HELD_NEW_CONTEXT = 'browser.newContext';
const HELD_NEW_PAGE = 'browserContext.newPage';
const HELD_CONTEXT_CLOSE = 'browserContext.close';

interface FakeParkingLot {
  park<T>(call: string, settle: () => T): { settled: Promise<T>; release: () => void };
  held(): string[];
  releaseAll(): void;
}

function fakeParkingLot(): FakeParkingLot {
  const parked = new Set<{ call: string; release: () => void }>();
  return {
    park<T>(call: string, settle: () => T) {
      let release = (): void => {};
      const settled = new Promise<T>((resolve, reject) => {
        const entry = {
          call,
          release: () => {
            if (!parked.delete(entry)) return;
            try {
              resolve(settle());
            } catch (err) {
              reject(err);
            }
          },
        };
        parked.add(entry);
        release = entry.release;
      });
      return { settled, release };
    },
    held: () => [...parked].map((entry) => entry.call),
    releaseAll: () => {
      for (const entry of parked) entry.release();
    },
  };
}

function timersBeyondFakePages(probes: FakeProbes): number {
  const owned = probes.pages.reduce((sum, page) => sum + page.pendingTimers(), 0);
  return vi.getTimerCount() - owned;
}

function modelled<T>(owner: FakeOwner, members: Record<string, unknown>): T {
  const declared = [...FAKE_MODELLED_MEMBERS[owner]].sort();
  const built = Object.keys(members).sort();
  if (built.join(',') !== declared.join(',')) {
    throw new Error(
      `the fake ${owner} builds [${built.join(', ')}] while FAKE_MODELLED_MEMBERS declares [${declared.join(', ')}], so the drift canary would check a different surface than the warmup runs against`,
    );
  }
  return new Proxy(members, {
    get(target, key, receiver) {
      if (typeof key === 'symbol' || Object.hasOwn(target, key)) {
        return Reflect.get(target, key, receiver);
      }
      if (key === 'then') return undefined;
      throw new Error(
        `the fake first-load ${owner} does not model ${owner}#${key}, so a warmup reaching for it would run against behaviour nothing in this suite stands in for. Model it, add it to FAKE_MODELLED_MEMBERS so the drift canary checks it against the installed playwright client, and extend the fake's conformance test`,
      );
    },
  }) as T;
}

function fakeEmitter<Event extends string>(self: () => unknown) {
  const listeners = new Map<string, Array<{ listener: FakeListener; once: boolean }>>();
  const add = (once: boolean) => (event: string, listener: FakeListener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), { listener, once }]);
    return self();
  };
  const remove = (event: string, listener: FakeListener) => {
    listeners.set(
      event,
      (listeners.get(event) ?? []).filter((entry) => entry.listener !== listener),
    );
    return self();
  };
  return {
    members: {
      on: add(false),
      addListener: add(false),
      once: add(true),
      off: remove,
      removeListener: remove,
      removeAllListeners: (event?: string) => {
        if (event === undefined) listeners.clear();
        else listeners.delete(event);
        return self();
      },
    },
    emit(event: Event, payload: unknown): void {
      const current = listeners.get(event) ?? [];
      listeners.set(
        event,
        current.filter((entry) => !entry.once),
      );
      for (const entry of current) entry.listener(payload);
    },
    listening(): string[] {
      return [...listeners]
        .filter(([, entries]) => entries.length > 0)
        .map(([event]) => event)
        .sort();
    },
  };
}

function fakeTimeoutError(call: string, timeoutMs: number): Error {
  return new errors.TimeoutError(`${call}: Timeout ${timeoutMs}ms exceeded.`);
}

function fakeClosedError(call: string): Error {
  return new Error(`${call}: Target page, context or browser has been closed`);
}

function explicitTimeoutOf(call: string, options: FakeWaitOptions | undefined): number {
  const timeout = options?.timeout;
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0) return timeout;
  throw new Error(
    `${call} was called with timeout ${String(timeout)}. The fake first-load page models an explicit bound only: playwright-core resolves an omitted one through the context default, which the runner sets from navigationTimeout only while its test-scoped context-options fixture is live and which otherwise falls back to the library default, so which of the two a worker-scoped warmup inherits is not something this fake can know. Pass the bound explicitly, 0 for none`,
  );
}

function waitStateOf<State extends string>(
  call: string,
  value: unknown,
  supported: readonly State[],
): State {
  const state = value ?? 'load';
  if ((supported as readonly unknown[]).includes(state)) return state as State;
  throw new Error(
    `${call} was asked to wait for "${String(state)}", which the fake first-load page does not model; it reaches ${supported.join(', ')} only`,
  );
}

function fakeRequestPair(url: string, resourceType: string): FakeRequestPair {
  const pair: FakeRequestPair = {
    url,
    resourceType,
    completed: false,
    failed: false,
    request: undefined,
    response: undefined,
  };
  pair.request = modelled('Request', {
    url: () => url,
    method: () => 'GET',
    resourceType: () => resourceType,
    failure: () => (pair.failed ? { errorText: FAKE_REQUEST_FAILURE_TEXT } : null),
    response: async () => (pair.completed ? pair.response : null),
  });
  pair.response = modelled('Response', {
    url: () => url,
    status: () => FAKE_RESPONSE_STATUS,
    ok: () => true,
    request: () => pair.request,
  });
  return pair;
}

function fakeFirstLoadPage(
  script: FirstLoadScript,
  renderedEntryNames: readonly string[],
  record: FirstLoadRecord,
  context: () => unknown,
  emitOnContext: (event: FakeContextEvent, payload: unknown) => void,
  probes: FakeProbes,
): { handle: FakePage; close: () => void; probe: FakePageProbe } {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const rejectOnClose = new Set<() => void>();
  const waiters = new Set<{ state: FakeNavigationState; done: () => void }>();
  const reached = new Set<FakeNavigationState>();
  const issued: FakeRequestPair[] = [];
  let closed = false;
  let navigatedTo: string | undefined;
  const emitter = fakeEmitter<FakePageEvent>(() => handle);

  const schedule = (delayMs: number, run: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, delayMs);
    timers.add(timer);
  };

  const reach = (state: FakeNavigationState): void => {
    reached.add(state);
    for (const waiter of waiters) if (waiter.state === state) waiter.done();
  };

  const settleWhen = (
    call: string,
    state: FakeNavigationState | undefined,
    timeoutMs: number,
  ): Promise<void> => {
    if (closed) return Promise.reject(fakeClosedError(call));
    if (state !== undefined && reached.has(state)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timers.delete(timer);
        }
        rejectOnClose.delete(failClosed);
        waiters.delete(waiter);
      };
      const failClosed = (): void => {
        finish();
        reject(fakeClosedError(call));
      };
      const waiter = {
        state: state ?? 'load',
        done: () => {
          finish();
          resolve();
        },
      };
      rejectOnClose.add(failClosed);
      if (state !== undefined) waiters.add(waiter);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          finish();
          reject(fakeTimeoutError(call, timeoutMs));
        }, timeoutMs);
        timers.add(timer);
      }
    });
  };

  const issue = (pair: FakeRequestPair, countsAsScript: boolean): void => {
    issued.push(pair);
    if (countsAsScript) record.requestsIssued += 1;
    record.lastProgressAt = Date.now();
    emitter.emit('request', pair.request);
    emitOnContext('request', pair.request);
  };

  const complete = (pair: FakeRequestPair, countsAsScript: boolean): void => {
    pair.completed = true;
    if (countsAsScript) record.requestsCompleted += 1;
    record.lastProgressAt = Date.now();
    emitter.emit('response', pair.response);
    emitOnContext('response', pair.response);
    emitter.emit('requestfinished', pair.request);
    emitOnContext('requestfinished', pair.request);
  };

  const fail = (pair: FakeRequestPair): void => {
    pair.failed = true;
    record.requestsFailed += 1;
    record.lastProgressAt = Date.now();
    emitter.emit('requestfailed', pair.request);
    emitOnContext('requestfailed', pair.request);
  };

  const replay = (timeline: FirstLoadTimeline, url: string, document: FakeRequestPair): void => {
    const [documentIssuedAtMs, documentSettledAtMs] = timeline.document;
    schedule(documentIssuedAtMs, () => issue(document, false));
    schedule(documentSettledAtMs, () => {
      complete(document, false);
      reach('commit');
    });
    for (const [index, [issuedAtMs, settledAtMs]] of timeline.requests.entries()) {
      const pair = fakeRequestPair(fakeModuleUrl(url, index), FAKE_SCRIPT_RESOURCE_TYPE);
      schedule(issuedAtMs, () => issue(pair, true));
      schedule(settledAtMs, () => complete(pair, true));
    }
    schedule(timeline.loadAtMs, () => {
      record.loadedAt = Date.now();
      reach('domcontentloaded');
      emitter.emit('domcontentloaded', handle);
      reach('load');
      emitter.emit('load', handle);
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const failClosed of rejectOnClose) failClosed();
    emitter.emit('close', handle);
  };

  const handle: FakePage = modelled<FakePage>('Page', {
    ...emitter.members,
    goto: async (url: string, options?: FakeWaitOptions) => {
      record.listeningAtGoto.push(emitter.listening());
      const timeoutMs = explicitTimeoutOf('page.goto', options);
      const waitUntil = waitStateOf('page.goto', options?.waitUntil, FAKE_NAVIGATION_STATES);
      if (closed) throw fakeClosedError('page.goto');
      if (navigatedTo !== undefined) {
        throw new Error(
          `the fake first-load page models one navigation per page and was already navigated to ${navigatedTo}`,
        );
      }
      navigatedTo = url;
      record.navigations.push(url);
      const document = fakeRequestPair(url, FAKE_DOCUMENT_RESOURCE_TYPE);
      if (script.timeline !== undefined) {
        replay(script.timeline, url, document);
        await settleWhen('page.goto', waitUntil, timeoutMs);
        return document.response;
      }
      const scripts = Array.from({ length: script.requests }, (_, index) =>
        fakeRequestPair(fakeModuleUrl(url, index), FAKE_SCRIPT_RESOURCE_TYPE),
      );
      schedule(0, () => {
        issue(document, false);
        complete(document, false);
        reach('commit');
        for (const pair of scripts) issue(pair, true);
      });
      const failing = script.failing ?? 0;
      for (const [index, pair] of scripts.slice(0, script.completing).entries()) {
        schedule((index + 1) * script.completionSpacingMs, () =>
          index < failing ? fail(pair) : complete(pair, true),
        );
      }
      if (script.completing === script.requests) {
        schedule(script.requests * script.completionSpacingMs, () => {
          record.loadedAt = Date.now();
          reach('domcontentloaded');
          emitter.emit('domcontentloaded', handle);
          reach('load');
          emitter.emit('load', handle);
        });
      }
      await settleWhen('page.goto', waitUntil, timeoutMs);
      return document.response;
    },
    waitForLoadState: async (state?: unknown, options?: FakeWaitOptions) => {
      const timeoutMs = explicitTimeoutOf('page.waitForLoadState', options);
      const loadState = waitStateOf('page.waitForLoadState', state, FAKE_LOAD_STATES);
      await settleWhen('page.waitForLoadState', loadState, timeoutMs);
    },
    getByRole: (role: string, options?: { name?: unknown }) => {
      if (role !== FAKE_RENDERED_ROLE) {
        throw new Error(
          `the fake first-load page renders ${FAKE_RENDERED_ROLE} entries only and was asked for role "${role}"`,
        );
      }
      const name = options?.name;
      return modelled('Locator', {
        waitFor: async (waitOptions?: FakeWaitOptions) => {
          record.listeningAtVisibleWait.push(emitter.listening());
          record.timersBeyondPagesAtVisibleWait.push(
            vi.isFakeTimers() ? timersBeyondFakePages(probes) : undefined,
          );
          const timeoutMs = explicitTimeoutOf('locator.waitFor', waitOptions);
          waitStateOf('locator.waitFor', waitOptions?.state ?? 'visible', ['visible']);
          record.visibleWaits.push(String(name));
          const rendered = typeof name === 'string' && renderedEntryNames.includes(name);
          await settleWhen('locator.waitFor', rendered ? 'load' : undefined, timeoutMs);
        },
      });
    },
    url: () => navigatedTo ?? 'about:blank',
    context,
    isClosed: () => closed,
    close: async () => close(),
  });

  const probe: FakePageProbe = {
    listening: () => emitter.listening(),
    pendingTimers: () => timers.size,
    requests: () =>
      issued.map((pair) => ({
        url: pair.url,
        resourceType: pair.resourceType,
        completed: pair.completed,
      })),
  };
  return { handle, close, probe };
}

function fakeFirstLoadContext(
  script: FirstLoadScript,
  renderedEntryNames: readonly string[],
  record: FirstLoadRecord,
  probes: FakeProbes,
  holds: FakeHolds,
  lot: FakeParkingLot,
): FakeContext {
  const emitter = fakeEmitter<FakeContextEvent>(() => handle);
  const pages: FakePage[] = [];
  const pageProbes: FakePageProbe[] = [];
  const closers: Array<() => void> = [];
  let closed = false;
  let closeParked = false;
  const finishClose = (): void => {
    if (closed) return;
    closed = true;
    for (const close of closers) close();
    record.contextsClosed += 1;
    emitter.emit('close', handle);
  };
  const handle: FakeContext = modelled<FakeContext>('BrowserContext', {
    ...emitter.members,
    newPage: async () => {
      if (closed) throw fakeClosedError('browserContext.newPage');
      if (holds.newPage === true) {
        const parkedPage = lot.park<FakePage>(HELD_NEW_PAGE, () => {
          throw fakeClosedError(HELD_NEW_PAGE);
        });
        closers.push(parkedPage.release);
        return parkedPage.settled;
      }
      const page = fakeFirstLoadPage(
        script,
        renderedEntryNames,
        record,
        () => handle,
        (event, payload) => emitter.emit(event, payload),
        probes,
      );
      pages.push(page.handle);
      pageProbes.push(page.probe);
      probes.pages.push(page.probe);
      closers.push(page.close);
      return page.handle;
    },
    pages: () => [...pages],
    close: async () => {
      if (closed) return;
      for (const probe of pageProbes) record.listeningAtContextClose.push(probe.listening());
      if (holds.contextClose === true && !closeParked) {
        closeParked = true;
        return lot.park(HELD_CONTEXT_CLOSE, finishClose).settled;
      }
      finishClose();
    },
  });
  return handle;
}

function fakeFirstLoadBrowser(
  script: FirstLoadScript,
  renderedEntryNames: readonly string[],
  holds: FakeHolds = {},
): { browser: FakeBrowser; record: FirstLoadRecord; observe: FirstLoadObserver } {
  const record: FirstLoadRecord = {
    navigations: [],
    requestsIssued: 0,
    requestsCompleted: 0,
    requestsFailed: 0,
    lastProgressAt: undefined,
    loadedAt: undefined,
    visibleWaits: [],
    contextsOpened: 0,
    contextsClosed: 0,
    listeningAtGoto: [],
    listeningAtVisibleWait: [],
    listeningAtContextClose: [],
    timersBeyondPagesAtVisibleWait: [],
  };
  const probes: FakeProbes = { contexts: [], pages: [] };
  const lot = fakeParkingLot();
  const openContext = (): FakeContext => {
    const context = fakeFirstLoadContext(script, renderedEntryNames, record, probes, holds, lot);
    probes.contexts.push(context);
    return context;
  };
  const browser = modelled<FakeBrowser>('Browser', {
    newContext: async () => {
      record.contextsOpened += 1;
      if (holds.newContext === 'rejected-when-released') {
        return lot.park<FakeContext>(HELD_NEW_CONTEXT, () => {
          throw fakeClosedError(HELD_NEW_CONTEXT);
        }).settled;
      }
      if (holds.newContext === 'handed-back-when-released') {
        return lot.park(HELD_NEW_CONTEXT, openContext).settled;
      }
      return openContext();
    },
  });
  const observe: FirstLoadObserver = {
    contexts: probes.contexts,
    listening: () => probes.pages.map((page) => page.listening()),
    timersBeyondPages: () => timersBeyondFakePages(probes),
    requests: () => probes.pages.flatMap((page) => page.requests()),
    held: () => lot.held(),
    releaseHeld: () => lot.releaseAll(),
  };
  return { browser, record, observe };
}

interface Settlement {
  state: 'pending' | 'resolved' | 'rejected';
  at: number | undefined;
  reason: unknown;
}

function settlementOf(run: Promise<unknown>): Settlement {
  const settlement: Settlement = { state: 'pending', at: undefined, reason: undefined };
  void run.then(
    () => {
      settlement.state = 'resolved';
      settlement.at = Date.now();
    },
    (reason: unknown) => {
      settlement.state = 'rejected';
      settlement.at = Date.now();
      settlement.reason = reason;
    },
  );
  return settlement;
}

function describeSettlement(settlement: Settlement, startedAt: number): string {
  if (settlement.at === undefined) return 'still pending';
  const reason = settlement.reason instanceof Error ? `: ${settlement.reason.message}` : '';
  return `${settlement.state} ${settlement.at - startedAt}ms of fake time after the warmup started${reason}`;
}

function spacingOutlasting(outlastMs: number): number {
  return Math.ceil(outlastMs / OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS);
}

function spacingSettlingBefore(settleByMs: number): number {
  return Math.floor((settleByMs - 1) / OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS);
}

const PLAYWRIGHT_CLIENT_MODULES = {
  events: './lib/client/events.js',
  Browser: './lib/client/browser.js',
  BrowserContext: './lib/client/browserContext.js',
  Page: './lib/client/page.js',
  Locator: './lib/client/locator.js',
  network: './lib/client/network.js',
} as const;

interface PlaywrightClientSurface {
  version: string;
  prototypes: Partial<Record<FakeOwner, object>>;
  pageEvents: readonly string[];
  contextEvents: readonly string[];
}

function playwrightClientSurface(): PlaywrightClientSurface {
  const fromHere = createRequire(import.meta.url);
  const fromPlaywrightTest = createRequire(fromHere.resolve('@playwright/test'));
  const fromPlaywright = createRequire(fromPlaywrightTest.resolve('playwright/package.json'));
  const corePackageJson = fromPlaywright.resolve('playwright-core/package.json');
  const fromCore = createRequire(corePackageJson);
  const load = (path: string): Record<string, unknown> => {
    try {
      return fromCore(path) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `the fake first-load page's drift canary reads playwright-core's client module ${path}, which the resolved playwright-core no longer ships at that path. Re-verify the fake against this release and move the path, or replace the canary`,
        { cause: err },
      );
    }
  };
  const prototypeOf = (value: unknown): object | undefined =>
    typeof value === 'function' ? (value as { prototype: object }).prototype : undefined;
  const events = load(PLAYWRIGHT_CLIENT_MODULES.events).Events as
    | { Page?: Record<string, string>; BrowserContext?: Record<string, string> }
    | undefined;
  const network = load(PLAYWRIGHT_CLIENT_MODULES.network);
  return {
    version: resolvedPackageVersion(corePackageJson),
    prototypes: {
      Browser: prototypeOf(load(PLAYWRIGHT_CLIENT_MODULES.Browser).Browser),
      BrowserContext: prototypeOf(load(PLAYWRIGHT_CLIENT_MODULES.BrowserContext).BrowserContext),
      Page: prototypeOf(load(PLAYWRIGHT_CLIENT_MODULES.Page).Page),
      Locator: prototypeOf(load(PLAYWRIGHT_CLIENT_MODULES.Locator).Locator),
      Request: prototypeOf(network.Request),
      Response: prototypeOf(network.Response),
    },
    pageEvents: Object.values(events?.Page ?? {}),
    contextEvents: Object.values(events?.BrowserContext ?? {}),
  };
}

function unmatchedFakeMembers(
  prototypes: Partial<Record<string, object>>,
  modelledMembers: Readonly<Record<string, readonly string[]>>,
): string[] {
  const unmatched: string[] = [];
  for (const [owner, members] of Object.entries(modelledMembers)) {
    const prototype = prototypes[owner] as Record<string, unknown> | undefined;
    for (const member of members) {
      if (typeof prototype?.[member] !== 'function') unmatched.push(`${owner}#${member}`);
    }
  }
  return unmatched;
}

function unmatchedFakeEvents(real: readonly string[], emitted: readonly string[]): string[] {
  return emitted.filter((event) => !real.includes(event));
}

describe('worker-server fixture first-load warmup liveness', () => {
  test('the fake first-load page models only members and events the installed playwright client exposes', () => {
    const client = playwrightClientSurface();
    expect(
      client.version,
      `the client modules this canary reads ship in the playwright-core the worker-internals pin names, so a release that moves them is caught by the same re-verification`,
    ).toBe(PLAYWRIGHT_WORKER_INTERNALS_VERIFIED_AT);

    expect(
      unmatchedFakeMembers(client.prototypes, FAKE_MODELLED_MEMBERS),
      'every member the fake exposes must exist on the real playwright client class it stands in for, or a warmup written against the fake calls something production does not have',
    ).toEqual([]);
    expect(
      unmatchedFakeEvents(client.pageEvents, FAKE_PAGE_EVENTS),
      'every page event the fake emits must be one the real Page emits, or a progress watcher keyed on it would hear the fake and never production',
    ).toEqual([]);
    expect(unmatchedFakeEvents(client.contextEvents, FAKE_CONTEXT_EVENTS)).toEqual([]);

    expect(
      unmatchedFakeMembers(client.prototypes, {
        Page: [...FAKE_MODELLED_MEMBERS.Page, PLANTED_UNREAL_MEMBER],
      }),
      'the must-fire control: a member the real Page lacks is named rather than admitted',
    ).toEqual([`Page#${PLANTED_UNREAL_MEMBER}`]);
    expect(
      unmatchedFakeMembers({}, { Locator: FAKE_MODELLED_MEMBERS.Locator }),
      'a class the loader could not reach is named rather than read as a surface with nothing missing',
    ).toEqual(FAKE_MODELLED_MEMBERS.Locator.map((member) => `Locator#${member}`));
    expect(
      unmatchedFakeEvents(client.pageEvents, [PLANTED_UNREAL_EVENT]),
      'the must-fire control: an event the real Page never emits is named rather than admitted',
    ).toEqual([PLANTED_UNREAL_EVENT]);
  });

  test('the fake first-load page honours a navigation bound while the load it bounds keeps running behind it', async () => {
    vi.useFakeTimers();
    try {
      const stalled = fakeFirstLoadBrowser(
        {
          requests: FAKE_SELF_TEST_REQUESTS,
          completionSpacingMs: FAKE_SELF_TEST_SPACING_MS,
          completing: 0,
        },
        [FAKE_SELF_TEST_ENTRY],
      );
      const stalledPage = await (await stalled.browser.newContext()).newPage();
      const bounded = settlementOf(
        stalledPage.goto(FAKE_FIRST_LOAD_URL, { timeout: FAKE_SELF_TEST_BOUND_MS }),
      );
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_BOUND_MS - 1);
      expect(bounded.state, 'a navigation is not refused before the bound it was handed').toBe(
        'pending',
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(
        bounded.state,
        'playwright rejects a navigation whose load has not fired when its explicit bound elapses, and the liveness tests below red the fixed bound only because the fake keeps that contract',
      ).toBe('rejected');
      expect(bounded.reason).toBeInstanceOf(errors.TimeoutError);

      const unboundedPage = await (await stalled.browser.newContext()).newPage();
      const unbounded = settlementOf(unboundedPage.goto(FAKE_FIRST_LOAD_URL, { timeout: 0 }));
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_BOUND_MS * FAKE_SELF_TEST_SPACING_MS);
      expect(unbounded.state, 'a bound of 0 disables the navigation timeout').toBe('pending');
      await unboundedPage.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(unbounded.state, 'closing the page rejects the navigation still pending on it').toBe(
        'rejected',
      );

      const omittedPage = await (await stalled.browser.newContext()).newPage();
      const omitted = settlementOf(omittedPage.goto(FAKE_FIRST_LOAD_URL));
      await vi.advanceTimersByTimeAsync(0);
      expect(
        omitted.state,
        'an omitted bound is outside the slice this fake can stand in for, so it is refused at once rather than defaulted to a bound the fake would have to guess',
      ).toBe('rejected');
      expect(String((omitted.reason as Error | undefined)?.message)).toMatch(
        /models an explicit bound only/,
      );
      expect(
        () => (omittedPage as unknown as Record<string, unknown>)[FAKE_SELF_TEST_UNMODELLED_MEMBER],
        'a member the fake does not model is refused by name rather than read as undefined',
      ).toThrow(new RegExp(`does not model Page#${FAKE_SELF_TEST_UNMODELLED_MEMBER}`));

      const progressing = fakeFirstLoadBrowser(
        {
          requests: FAKE_SELF_TEST_REQUESTS,
          completionSpacingMs: FAKE_SELF_TEST_SPACING_MS,
          completing: FAKE_SELF_TEST_REQUESTS,
        },
        [FAKE_SELF_TEST_ENTRY],
      );
      const context = await progressing.browser.newContext();
      const page = await context.newPage();
      const pageEvents: string[] = [];
      const contextEvents: string[] = [];
      for (const event of FAKE_PAGE_EVENTS) page.on(event, () => pageEvents.push(event));
      for (const event of FAKE_CONTEXT_EVENTS) context.on(event, () => contextEvents.push(event));
      const outrun = settlementOf(
        page.goto(FAKE_FIRST_LOAD_URL, { timeout: FAKE_SELF_TEST_BOUND_MS }),
      );
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_REQUESTS * FAKE_SELF_TEST_SPACING_MS);
      expect(outrun.state).toBe('rejected');
      expect(outrun.reason).toBeInstanceOf(errors.TimeoutError);
      expect(
        progressing.record.requestsCompleted,
        'a navigation whose bound elapsed keeps loading in the browser; the bound refuses the wait, not the load',
      ).toBe(FAKE_SELF_TEST_REQUESTS);
      expect(
        pageEvents,
        'the document commits first, the module requests are issued before any completes, each completion is a response then a requestfinished, and the load events follow the last completion',
      ).toEqual([
        'request',
        'response',
        'requestfinished',
        'request',
        'request',
        'response',
        'requestfinished',
        'response',
        'requestfinished',
        'domcontentloaded',
        'load',
      ]);
      expect(
        contextEvents,
        'the context hears every network event its page emits, and no page lifecycle event',
      ).toEqual([
        'request',
        'response',
        'requestfinished',
        'request',
        'request',
        'response',
        'requestfinished',
        'response',
        'requestfinished',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a first load that keeps completing requests is admitted, however far past the navigation reserve it runs, up to the fixture's starvation line", async () => {
    const budget = await declaredFirstLoadBudget();
    const spacingMs = spacingSettlingBefore(budget.starvationLineMs);
    const { browser, record } = fakeFirstLoadBrowser(
      {
        requests: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
        completionSpacingMs: spacingMs,
        completing: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
      },
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const settlement = settlementOf(
        budget.warmup(
          browser,
          FAKE_FIRST_LOAD_BASE_URL,
          budget.openPhase(FIRST_LOAD_PHASE_NAME, budget.setupOverheadReserveMs),
        ),
      );
      await vi.advanceTimersByTimeAsync(
        OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS * spacingMs + budget.visibleReserveMs,
      );

      expect(
        record.navigations,
        'the warmup must navigate the fake page to the app root, or nothing below observed a first load',
      ).toEqual([FAKE_FIRST_LOAD_URL]);
      expect(
        settlement.state,
        `the warmup's own bound refused a first load that was still completing a request every ${spacingMs}ms (${describeSettlement(settlement, startedAt)}). A bound on a load that is still making progress is a throughput threshold, and it fails a healthy cold load whenever the dev server gets less of a core. Before the fixture's ${budget.starvationLineMs}ms starvation line the warmup must refuse only a load that has stopped making progress`,
      ).toBe('resolved');
      expect(
        record.requestsCompleted,
        'the admitted load must be the whole scripted load, or the scenario did not run as long as this test claims',
      ).toBe(OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS);
      const loadedAfterMs = (record.loadedAt as number) - startedAt;
      expect(
        loadedAfterMs,
        `the scenario's load must outlast the ${budget.navigationReserveMs}ms navigation reserve, so a fixed navigation total of that reserve refuses it`,
      ).toBeGreaterThan(budget.navigationReserveMs);
      expect(
        loadedAfterMs,
        `and must reach its load before the ${budget.starvationLineMs}ms starvation line, where the fixture refuses a setup that has not finished, so admitting it is owed`,
      ).toBeLessThan(budget.starvationLineMs);
      expect(
        record.visibleWaits,
        'the warmup must still wait for the seeded tree entry once the load completes',
      ).toEqual([budget.renderedEntryNames[0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a first load that never completes a request is refused sooner than the navigation reserve would have refused it', async () => {
    const budget = await declaredFirstLoadBudget();
    const { browser, record } = fakeFirstLoadBrowser(
      {
        requests: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
        completionSpacingMs: spacingOutlasting(budget.totalMs + budget.navigationReserveMs),
        completing: 0,
      },
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const settlement = settlementOf(
        budget.warmup(
          browser,
          FAKE_FIRST_LOAD_BASE_URL,
          budget.openPhase(FIRST_LOAD_PHASE_NAME, budget.setupOverheadReserveMs),
        ),
      );
      await vi.advanceTimersByTimeAsync(budget.navigationReserveMs - 1);

      expect(record.navigations).toEqual([FAKE_FIRST_LOAD_URL]);
      expect(
        record.requestsIssued,
        'the stall under test is a load whose requests are all outstanding, not a navigation that never started',
      ).toBe(OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS);
      expect(record.requestsCompleted).toBe(0);
      expect(
        settlement.state,
        `a first load that completed none of its ${OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS} requests was ${describeSettlement(settlement, startedAt)} one millisecond before the ${budget.navigationReserveMs}ms navigation reserve elapsed. A load that has stopped making progress must be refused by a bound that watches progress, sooner than a fixed total spends on it. If a progress watcher exists and this still reds, check that its clock is one vitest fake timers advance (global setTimeout, setInterval, Date or performance), not node:timers/promises or AbortSignal.timeout`,
      ).toBe('rejected');
      expect(
        record.contextsClosed,
        'a refused first load must be torn down with its browser context, not left navigating behind the refusal',
      ).toBe(record.contextsOpened);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a first load that stops completing requests after outrunning the navigation reserve is refused once it stops, not while it progresses', async () => {
    const budget = await declaredFirstLoadBudget();
    const spacingMs = spacingOutlasting(budget.totalMs + budget.navigationReserveMs);
    const completing = Math.ceil(
      (budget.navigationReserveMs * PROGRESS_PAST_RESERVE_FACTOR) / spacingMs,
    );
    expect(completing).toBeLessThan(OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS);
    const { browser, record } = fakeFirstLoadBrowser(
      {
        requests: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
        completionSpacingMs: spacingMs,
        completing,
      },
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const settlement = settlementOf(
        budget.warmup(
          browser,
          FAKE_FIRST_LOAD_BASE_URL,
          budget.openPhase(FIRST_LOAD_PHASE_NAME, budget.setupOverheadReserveMs),
        ),
      );
      await vi.advanceTimersByTimeAsync(completing * spacingMs);

      expect(record.navigations).toEqual([FAKE_FIRST_LOAD_URL]);
      expect(
        settlement.state,
        `the warmup was ${describeSettlement(settlement, startedAt)}, while the load was still completing a request every ${spacingMs}ms and had not yet stopped. Progress past the ${budget.navigationReserveMs}ms navigation reserve is still progress`,
      ).toBe('pending');
      expect(
        record.requestsCompleted,
        'the load must have progressed right up to the point this test calls its stall',
      ).toBe(completing);
      const stalledAt = record.lastProgressAt as number;
      expect(stalledAt - startedAt).toBeGreaterThan(budget.navigationReserveMs);

      await vi.advanceTimersByTimeAsync(budget.navigationReserveMs - 1);
      expect(
        settlement.state,
        `a first load that stopped completing requests ${stalledAt - startedAt}ms in was ${describeSettlement(settlement, startedAt)}, one millisecond short of a full ${budget.navigationReserveMs}ms navigation reserve after it stopped. Its stall must be refused sooner than that`,
      ).toBe('rejected');
      expect(record.contextsClosed).toBe(record.contextsOpened);
    } finally {
      vi.useRealTimers();
    }
  });
});

const LOAD_PROGRESS_MODULE = '../stress/_helpers/load-progress.ts';
const GOTO_WHILE_LOAD_PROGRESSES_EXPORT = 'gotoWhileLoadProgresses';
const REQUEST_COMPLETION_EVENTS = ['response', 'requestfinished', 'requestfailed'] as const;
const MISSING_STALL_WINDOWS = [undefined, Number.NaN, 0] as const;
const UNUSABLE_DEADLINES = [Number.NaN, Number.POSITIVE_INFINITY, 0] as const;

type GotoWhileLoadProgresses = (
  page: unknown,
  url: string,
  stallMs: number,
  deadlineAt?: number,
) => Promise<void>;

const SELF_TEST_FIRST_LOAD: SpacedFirstLoadScript = {
  requests: FAKE_SELF_TEST_REQUESTS,
  completionSpacingMs: FAKE_SELF_TEST_SPACING_MS,
  completing: FAKE_SELF_TEST_REQUESTS,
};

async function declaredFirstLoadStallMs(navigationReserveMs: number): Promise<number> {
  const resolve = (await fixtureExports())[RESOLVE_FIRST_LOAD_STALL_EXPORT];
  expect(
    typeof resolve,
    `${FIXTURE_MODULE} must export ${RESOLVE_FIRST_LOAD_STALL_EXPORT}, the resolver that derives the first load's stall window from ${DECLARED_RESERVES_EXPORT}.${WARMUP_GOTO_RESERVE_KEY}, so a stall refusal is checked against the window the fixture spends rather than a number this suite restates`,
  ).toBe('function');
  const stallMs = (resolve as (navigationShareMs: number) => unknown)(navigationReserveMs);
  expect(
    typeof stallMs === 'number' && Number.isFinite(stallMs) && stallMs > 0,
    `${RESOLVE_FIRST_LOAD_STALL_EXPORT}(${navigationReserveMs}) must be a positive finite millisecond count, and returned ${String(stallMs)}`,
  ).toBe(true);
  return stallMs as number;
}

async function progressBoundedNavigation(): Promise<GotoWhileLoadProgresses> {
  let loaded: Record<string, unknown> = {};
  let loadFailure: unknown;
  try {
    loaded = (await import(LOAD_PROGRESS_MODULE)) as Record<string, unknown>;
  } catch (err) {
    loadFailure = err;
  }
  const notLoaded =
    loadFailure === undefined
      ? ''
      : ` The module did not load: ${loadFailure instanceof Error ? loadFailure.message : String(loadFailure)}`;
  const exported = loaded[GOTO_WHILE_LOAD_PROGRESSES_EXPORT];
  expect(
    typeof exported,
    `${LOAD_PROGRESS_MODULE} must export ${GOTO_WHILE_LOAD_PROGRESSES_EXPORT}(page, url, stallMs), the navigation the warmup bounds by forward progress rather than by a total.${notLoaded}`,
  ).toBe('function');
  return exported as GotoWhileLoadProgresses;
}

function firstLoadCompleting(
  budget: DeclaredFirstLoadBudget,
  completing: number,
): SpacedFirstLoadScript {
  return {
    requests: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
    completionSpacingMs: spacingSettlingBefore(budget.starvationLineMs),
    completing,
  };
}

function startedWarmup(
  budget: DeclaredFirstLoadBudget,
  browser: FakeBrowser,
): { startedAt: number; settlement: Settlement } {
  const startedAt = Date.now();
  const settlement = settlementOf(
    budget.warmup(
      browser,
      FAKE_FIRST_LOAD_BASE_URL,
      budget.openPhase(FIRST_LOAD_PHASE_NAME, budget.setupOverheadReserveMs),
    ),
  );
  return { startedAt, settlement };
}

function completionEventsAmong(events: readonly string[] | undefined): string[] {
  return (events ?? []).filter((event) =>
    (REQUEST_COMPLETION_EVENTS as readonly string[]).includes(event),
  );
}

function expectNavigationHearsCompletionsFromTheStart(record: FirstLoadRecord): void {
  expect(
    record.listeningAtGoto.length,
    'the warmup must have issued exactly one navigation, or nothing below observed what it listened to when it navigated',
  ).toBe(1);
  expect(
    completionEventsAmong(record.listeningAtGoto[0]),
    `when the warmup issued its navigation the page was listening to [${(record.listeningAtGoto[0] ?? []).join(', ')}], none of it a request completion (${REQUEST_COMPLETION_EVENTS.join(', ')}). A bound that watches progress must be subscribed before the navigation is sent, because playwright delivers a page's network events only once something listens; without it the release checks that follow would pass for a watcher that never existed`,
  ).not.toEqual([]);
}

function standaloneNumber(value: number): RegExp {
  return new RegExp(`(?<![\\d.\\-])${String(value).replaceAll('.', '\\.')}(?!\\d)`);
}

async function closeEveryContext(observe: FirstLoadObserver): Promise<void> {
  for (const context of observe.contexts) await context.close();
}

describe('worker-server fixture first-load warmup liveness releases and reports', () => {
  test('the fake first-load page records what is listening, which timers it does not own and which requests are outstanding, at the moments the release pins read them', async () => {
    vi.useFakeTimers();
    try {
      const heard = (): void => {};
      const loading = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [FAKE_SELF_TEST_ENTRY]);
      const page = await (await loading.browser.newContext()).newPage();
      page.on('requestfinished', heard);
      settlementOf(page.goto(FAKE_FIRST_LOAD_URL, { timeout: 0 }));
      page.on('response', heard);
      expect(
        loading.record.listeningAtGoto,
        'a listener attached before the navigation is seen at it, and one attached after it is not',
      ).toEqual([['requestfinished']]);
      expect(
        loading.observe.listening(),
        'the live read sees every listener still attached',
      ).toEqual([['requestfinished', 'response']]);
      page.off('requestfinished', heard);
      page.off('response', heard);
      expect(
        loading.observe.listening(),
        'a removed listener is not read as still attached',
      ).toEqual([[]]);

      await vi.advanceTimersByTimeAsync(0);
      expect(
        vi.getTimerCount(),
        'the page must still own pending load timers here, or the exclusion checked next is vacuous',
      ).toBeGreaterThan(0);
      expect(
        loading.observe.requests(),
        'once issued, the completed document is not outstanding and every module request is',
      ).toEqual([
        { url: FAKE_FIRST_LOAD_URL, resourceType: FAKE_DOCUMENT_RESOURCE_TYPE, completed: true },
        {
          url: fakeModuleUrl(FAKE_FIRST_LOAD_URL, 0),
          resourceType: FAKE_SCRIPT_RESOURCE_TYPE,
          completed: false,
        },
        {
          url: fakeModuleUrl(FAKE_FIRST_LOAD_URL, 1),
          resourceType: FAKE_SCRIPT_RESOURCE_TYPE,
          completed: false,
        },
      ]);

      const tree = page.getByRole(FAKE_RENDERED_ROLE, { name: FAKE_SELF_TEST_ENTRY });
      settlementOf(tree.waitFor({ timeout: 0 }));
      const planted = setTimeout(heard, FAKE_SELF_TEST_BOUND_MS);
      page.on('request', heard);
      expect(
        loading.observe.timersBeyondPages(),
        'a pending timer the page does not own is counted by the live read',
      ).toBe(1);
      settlementOf(tree.waitFor({ timeout: 0 }));
      clearTimeout(planted);
      page.off('request', heard);
      expect(
        loading.observe.timersBeyondPages(),
        "the page's own pending load timers are not counted by the live read",
      ).toBe(0);
      expect(
        loading.record.listeningAtVisibleWait,
        'a listener still attached when the tree wait is called is seen at it, and none is seen once removed',
      ).toEqual([[], ['request']]);
      expect(
        loading.record.timersBeyondPagesAtVisibleWait,
        "the page's own pending load timers are not counted at the tree wait, and a timer it does not own is",
      ).toEqual([0, 1]);

      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_SPACING_MS);
      expect(
        loading.observe
          .requests()
          .filter((request) => !request.completed)
          .map((request) => request.url),
        'a module request that has completed is no longer outstanding',
      ).toEqual([fakeModuleUrl(FAKE_FIRST_LOAD_URL, 1)]);

      const closing = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [FAKE_SELF_TEST_ENTRY]);
      const leakyContext = await closing.browser.newContext();
      (await leakyContext.newPage()).on('response', heard);
      await leakyContext.close();
      const tidyContext = await closing.browser.newContext();
      const tidyPage = await tidyContext.newPage();
      tidyPage.on('response', heard);
      tidyPage.off('response', heard);
      await tidyContext.close();
      expect(
        closing.record.listeningAtContextClose,
        'a listener still attached when its context closes is seen at the close, and one removed before it is not',
      ).toEqual([['response'], []]);

      const handles = fakeFirstLoadBrowser({ ...SELF_TEST_FIRST_LOAD, completing: 0 }, [
        FAKE_SELF_TEST_ENTRY,
      ]);
      const first = await handles.browser.newContext();
      const second = await handles.browser.newContext();
      const firstNavigation = settlementOf(
        (await first.newPage()).goto(FAKE_FIRST_LOAD_URL, { timeout: 0 }),
      );
      const secondNavigation = settlementOf(
        (await second.newPage()).goto(FAKE_FIRST_LOAD_URL, { timeout: 0 }),
      );
      expect(
        [handles.observe.contexts.indexOf(first), handles.observe.contexts.indexOf(second)],
        'the observer hands back every context the browser opened, in the order it opened them',
      ).toEqual([0, 1]);
      await handles.observe.contexts[0]?.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        firstNavigation.state,
        "closing a context through the observer's handle rejects the navigation pending in it",
      ).toBe('rejected');
      expect(secondNavigation.state, 'and leaves a context it did not close still navigating').toBe(
        'pending',
      );
      await second.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('the first-load navigation is already listening for request completions when it is issued, and only to events the installed playwright Page emits', async () => {
    const budget = await declaredFirstLoadBudget();
    const { browser, record, observe } = fakeFirstLoadBrowser(
      firstLoadCompleting(budget, OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS),
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      startedWarmup(budget, browser);
      await vi.advanceTimersByTimeAsync(0);

      expect(record.navigations).toEqual([FAKE_FIRST_LOAD_URL]);
      expectNavigationHearsCompletionsFromTheStart(record);

      const client = playwrightClientSurface();
      expect(
        unmatchedFakeEvents(client.pageEvents, REQUEST_COMPLETION_EVENTS),
        'the completion events this suite accepts as progress are themselves events the real Page emits',
      ).toEqual([]);
      const listened = record.listeningAtGoto[0] ?? [];
      expect(
        unmatchedFakeEvents(client.pageEvents, listened),
        `the navigation listens to [${listened.join(', ')}], and every one must be an event the installed playwright Page emits. A listener on a misspelt event hears nothing in production, and the fake cannot show it because it never emits that event either`,
      ).toEqual([]);
      expect(
        unmatchedFakeEvents(client.pageEvents, [...listened, PLANTED_UNREAL_EVENT]),
        'the must-fire control: an event the real Page never emits, listened to beside the real ones, is named',
      ).toEqual([PLANTED_UNREAL_EVENT]);
    } finally {
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });

  test('a first load the warmup admits has released its stall timer and every listener before the warmup waits for the tree', async () => {
    const budget = await declaredFirstLoadBudget();
    const script = firstLoadCompleting(budget, OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS);
    const { browser, record, observe } = fakeFirstLoadBrowser(script, budget.renderedEntryNames);

    vi.useFakeTimers();
    try {
      startedWarmup(budget, browser);
      await vi.advanceTimersByTimeAsync(
        OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS * script.completionSpacingMs + budget.visibleReserveMs,
      );

      expectNavigationHearsCompletionsFromTheStart(record);
      expect(
        record.listeningAtVisibleWait.length,
        'the warmup must have reached its tree wait once, or nothing below observed what the navigation left behind',
      ).toBe(1);
      expect(
        record.listeningAtVisibleWait,
        `when the warmup moved on to the tree wait its page was listening to ${JSON.stringify(record.listeningAtVisibleWait)}. The navigation must release every listener it attached once the load settles; the page is private to the warmup, so anything still listening here was left behind by the navigation`,
      ).toEqual([[]]);
      expect(
        record.timersBeyondPagesAtVisibleWait,
        `when the warmup moved on to the tree wait, timers the fake page does not own were pending: ${JSON.stringify(record.timersBeyondPagesAtVisibleWait)}. The navigation's stall timer must be cleared once the load it watches settles, or it outlives the navigation and fires into a warmup that has moved on`,
      ).toEqual([0]);
    } finally {
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });

  test('a first load refused as stalled has released its stall timer and every listener by the time the warmup closes its context', async () => {
    const budget = await declaredFirstLoadBudget();
    const { browser, record, observe } = fakeFirstLoadBrowser(
      firstLoadCompleting(budget, 0),
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const { startedAt, settlement } = startedWarmup(budget, browser);
      await vi.advanceTimersByTimeAsync(budget.navigationReserveMs - 1);

      expectNavigationHearsCompletionsFromTheStart(record);
      expect(
        settlement.state,
        `the stalled first load was ${describeSettlement(settlement, startedAt)}, so there is no refusal whose release this test can check`,
      ).toBe('rejected');
      expect(
        record.listeningAtContextClose.length,
        'the warmup must have closed its context once after the refusal, or nothing below observed what the navigation left behind',
      ).toBe(1);
      expect(
        record.listeningAtContextClose,
        `when the warmup closed its context after the stall refusal, its page was listening to ${JSON.stringify(record.listeningAtContextClose)}. The refused navigation must release every listener it attached before the refusal reaches the warmup`,
      ).toEqual([[]]);
      expect(
        observe.timersBeyondPages(),
        'a timer the fake page does not own was still pending after the stall refusal settled. A watchdog left running once the navigation it watches has settled keeps firing into a warmup that has already failed',
      ).toBe(0);
    } finally {
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });

  test('a first load whose context is closed under it while it still progresses is rejected at once, and leaves no listener or timer behind', async () => {
    const budget = await declaredFirstLoadBudget();
    const { browser, record, observe } = fakeFirstLoadBrowser(
      firstLoadCompleting(budget, OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS),
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const { startedAt, settlement } = startedWarmup(budget, browser);
      await vi.advanceTimersByTimeAsync(budget.navigationReserveMs * PROGRESS_PAST_RESERVE_FACTOR);

      expectNavigationHearsCompletionsFromTheStart(record);
      expect(
        settlement.state,
        `the progressing first load was ${describeSettlement(settlement, startedAt)} before this test closed its context, so the close would not be what ends it`,
      ).toBe('pending');
      expect(record.requestsCompleted, 'the load must have made progress').toBeGreaterThan(0);
      expect(observe.contexts.length, 'the warmup opens exactly one context').toBe(1);

      await observe.contexts[0]?.close();
      expect(
        completionEventsAmong(record.listeningAtContextClose[0]),
        'the navigation must still be listening when its context is closed under it, or the release checked below proves nothing',
      ).not.toEqual([]);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        settlement.state,
        `closing the warmup's context mid-load, as the browser fixture's teardown does once the registered slot preempts setup, left the warmup ${describeSettlement(settlement, startedAt)} with no fake time elapsed since the close. The navigation's rejection must end the warmup at once rather than wait out a stall window on a page that no longer exists`,
      ).toBe('rejected');
      expect(
        observe.listening(),
        'a navigation ended by its context closing must release every listener it attached',
      ).toEqual([[]]);
      expect(
        observe.timersBeyondPages(),
        'a navigation ended by its context closing must clear its stall timer rather than leave it to fire',
      ).toBe(0);
    } finally {
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });

  test('a stall refusal names how many requests are still outstanding, which ones, and the stall window the manifest derives', async () => {
    const budget = await declaredFirstLoadBudget();
    const stallMs = await declaredFirstLoadStallMs(budget.navigationReserveMs);
    const spacingMs = firstLoadCompleting(budget, 0).completionSpacingMs;
    const progressedBeforeStall = Math.ceil(
      (budget.navigationReserveMs * PROGRESS_PAST_RESERVE_FACTOR) / spacingMs,
    );
    const scenarios = [
      { completing: 0, refusedWithinMs: budget.navigationReserveMs - 1 },
      {
        completing: progressedBeforeStall,
        refusedWithinMs: progressedBeforeStall * spacingMs + budget.navigationReserveMs - 1,
      },
    ];

    for (const { completing, refusedWithinMs } of scenarios) {
      const { browser, observe } = fakeFirstLoadBrowser(
        firstLoadCompleting(budget, completing),
        budget.renderedEntryNames,
      );
      vi.useFakeTimers();
      try {
        const { startedAt, settlement } = startedWarmup(budget, browser);
        await vi.advanceTimersByTimeAsync(refusedWithinMs);

        expect(
          settlement.state,
          `the first load that stalled after ${completing} completions was ${describeSettlement(settlement, startedAt)}, so there is no refusal whose reason this test can read`,
        ).toBe('rejected');
        const reason =
          settlement.reason instanceof Error
            ? settlement.reason.message
            : String(settlement.reason);
        const outstanding = observe.requests().filter((request) => !request.completed);
        const completedModules = observe
          .requests()
          .filter(
            (request) => request.completed && request.resourceType === FAKE_SCRIPT_RESOURCE_TYPE,
          );
        expect(
          outstanding.length,
          'the scenario must leave every module request it did not complete outstanding',
        ).toBe(OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS - completing);
        expect(
          completedModules.length,
          'the scenario must have completed exactly the module requests it scripted',
        ).toBe(completing);

        expect(
          reason,
          `a stall refusal must say how many requests were still outstanding (${outstanding.length} after ${completing} completions), not how many were issued or finished, so a refused warmup says what it was waiting on`,
        ).toMatch(standaloneNumber(outstanding.length));
        expect(
          outstanding.filter((request) => reason.includes(request.url)).length,
          `a stall refusal must name at least one request still outstanding, and this one names none: ${reason}`,
        ).toBeGreaterThan(0);
        expect(
          completedModules
            .filter((request) => reason.includes(request.url))
            .map((request) => request.url),
          'a request that completed is not named as one the load was still waiting on',
        ).toEqual([]);
        expect(
          reason,
          `a stall refusal must name the ${stallMs}ms stall window ${RESOLVE_FIRST_LOAD_STALL_EXPORT} derives from the ${budget.navigationReserveMs}ms navigation share, so whoever reads it knows how long the load went without progress`,
        ).toMatch(standaloneNumber(stallMs));
      } finally {
        await closeEveryContext(observe);
        vi.useRealTimers();
      }
    }
  });

  test('the progress-bounded navigation refuses a missing, non-finite or zero stall window before it navigates, and navigates on a real one', async () => {
    const gotoWhileLoadProgresses = await progressBoundedNavigation();

    vi.useFakeTimers();
    try {
      for (const stallMs of MISSING_STALL_WINDOWS) {
        const { browser, record, observe } = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [
          FAKE_SELF_TEST_ENTRY,
        ]);
        const page = await (await browser.newContext()).newPage();
        let thrown: unknown;
        let returned: Promise<void> | undefined;
        try {
          returned = gotoWhileLoadProgresses(page, FAKE_FIRST_LOAD_URL, stallMs as number);
        } catch (err) {
          thrown = err;
        }
        expect(
          thrown,
          `a stall window of ${String(stallMs)} must be refused through the promise ${GOTO_WHILE_LOAD_PROGRESSES_EXPORT} returns, not thrown before it returns one`,
        ).toBeUndefined();
        const refused = settlementOf(returned ?? Promise.resolve());
        await vi.advanceTimersByTimeAsync(0);

        expect(
          refused.state,
          `a stall window of ${String(stallMs)} must be refused at once, not armed as a timer that fires in about a millisecond and reads as an instant stall`,
        ).toBe('rejected');
        expect(refused.reason).toBeInstanceOf(TypeError);
        const message = refused.reason instanceof Error ? refused.reason.message : '';
        expect(message).toMatch(new RegExp(GOTO_WHILE_LOAD_PROGRESSES_EXPORT));
        expect(message).toMatch(/millisecond bound/);
        expect(
          record.navigations,
          'a navigation refused for its missing stall window must not have been issued',
        ).toEqual([]);
        expect(observe.listening(), 'and leaves nothing subscribed on the page').toEqual([[]]);
        await closeEveryContext(observe);
      }

      const { browser, record, observe } = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [
        FAKE_SELF_TEST_ENTRY,
      ]);
      const page = await (await browser.newContext()).newPage();
      const admitted = settlementOf(
        gotoWhileLoadProgresses(page, FAKE_FIRST_LOAD_URL, FAKE_SELF_TEST_BOUND_MS),
      );
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_REQUESTS * FAKE_SELF_TEST_SPACING_MS);
      expect(
        admitted.state,
        'the adjacent control: a positive stall window longer than the gap between completions navigates and settles with the load',
      ).toBe('resolved');
      expect(
        record.navigations,
        'the admitted navigation must have navigated the page, not settled without it',
      ).toEqual([FAKE_FIRST_LOAD_URL]);
      expect(
        observe.listening(),
        'an admitted navigation must release every listener it attached',
      ).toEqual([[]]);
      expect(observe.timersBeyondPages(), 'an admitted navigation must clear its stall timer').toBe(
        0,
      );
      await closeEveryContext(observe);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the progress-bounded navigation refuses a non-finite or non-positive deadline before it navigates, and navigates up to a real one', async () => {
    const gotoWhileLoadProgresses = await progressBoundedNavigation();

    vi.useFakeTimers();
    try {
      for (const deadlineAt of UNUSABLE_DEADLINES) {
        const { browser, record, observe } = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [
          FAKE_SELF_TEST_ENTRY,
        ]);
        const page = await (await browser.newContext()).newPage();
        const refused = settlementOf(
          gotoWhileLoadProgresses(page, FAKE_FIRST_LOAD_URL, FAKE_SELF_TEST_BOUND_MS, deadlineAt),
        );
        await vi.advanceTimersByTimeAsync(0);

        expect(
          refused.state,
          `a deadline of ${String(deadlineAt)} must be refused at once, not armed as a timer Node sets to a millisecond, which reads as a load that ran out of time`,
        ).toBe('rejected');
        expect(refused.reason).toBeInstanceOf(TypeError);
        expect(
          settledReason(refused),
          'the refusal must name the deadline as the instant the caller has to finish by, not as a bound it spends',
        ).toMatch(
          new RegExp(`${GOTO_WHILE_LOAD_PROGRESSES_EXPORT} needs its caller to name the instant`),
        );
        expect(
          record.navigations,
          'a navigation refused for its unusable deadline must not have been issued',
        ).toEqual([]);
        expect(observe.listening(), 'and leaves nothing subscribed on the page').toEqual([[]]);
        await closeEveryContext(observe);
      }

      const { browser, record, observe } = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [
        FAKE_SELF_TEST_ENTRY,
      ]);
      const page = await (await browser.newContext()).newPage();
      const admitted = settlementOf(
        gotoWhileLoadProgresses(
          page,
          FAKE_FIRST_LOAD_URL,
          FAKE_SELF_TEST_BOUND_MS,
          Date.now() + FAKE_SELF_TEST_BOUND_MS * FAKE_SELF_TEST_SPACING_MS,
        ),
      );
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_REQUESTS * FAKE_SELF_TEST_SPACING_MS);
      expect(
        admitted.state,
        'the adjacent control: a finite deadline the load finishes well inside navigates and settles with the load',
      ).toBe('resolved');
      expect(record.navigations).toEqual([FAKE_FIRST_LOAD_URL]);
      expect(
        observe.timersBeyondPages(),
        'a navigation that finished before its deadline must clear the deadline timer with the stall timer',
      ).toBe(0);
      await closeEveryContext(observe);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the progress-bounded navigation handed a deadline that has already passed does not navigate, and says the first load was not started', async () => {
    const gotoWhileLoadProgresses = await progressBoundedNavigation();

    vi.useFakeTimers();
    try {
      for (const [deadline, behindMs] of [
        ['a millisecond behind the clock', 1],
        ['equal to the clock', 0],
      ] as const) {
        const { browser, record, observe } = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [
          FAKE_SELF_TEST_ENTRY,
        ]);
        const page = await (await browser.newContext()).newPage();
        const refused = settlementOf(
          gotoWhileLoadProgresses(
            page,
            FAKE_FIRST_LOAD_URL,
            FAKE_SELF_TEST_BOUND_MS,
            Date.now() - behindMs,
          ),
        );
        await vi.advanceTimersByTimeAsync(0);

        expect(
          refused.state,
          `a deadline ${deadline} leaves the first load no time, so the navigation must be refused at once`,
        ).toBe('rejected');
        const reason = settledReason(refused);
        expect(
          reason,
          `a deadline ${deadline} must be reported as a first load that was not started, not as one that ran out of time, or the failure describes browser work that never ran: ${reason}`,
        ).toContain(`first load of ${FAKE_FIRST_LOAD_URL} was not started`);
        expect(
          reason,
          `a first load that was not started neither made network progress nor stalled, so its refusal must say nothing about network progress: ${reason}`,
        ).not.toMatch(/network progress/);
        expect(
          record.navigations,
          `a deadline ${deadline} must not have issued the navigation it left no time for`,
        ).toEqual([]);
        expect(observe.listening(), 'and leaves nothing subscribed on the page').toEqual([[]]);
        expect(
          observe.timersBeyondPages(),
          'and leaves no stall or deadline timer armed behind the refusal',
        ).toBe(0);
        await closeEveryContext(observe);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('the progress-bounded navigation that reaches its deadline before the page has issued any request does not claim network progress it never observed', async () => {
    const gotoWhileLoadProgresses = await progressBoundedNavigation();
    const deadlineInMs = FAKE_SELF_TEST_BOUND_MS - 1;
    const firstRequestAtMs = deadlineInMs + 1;
    const quietPastTheDeadline: FirstLoadTimeline = {
      loadAtMs: firstRequestAtMs + 1,
      document: [firstRequestAtMs, firstRequestAtMs],
      requests: [[firstRequestAtMs, firstRequestAtMs]],
    };
    const { browser, record, observe } = fakeFirstLoadBrowser(
      recordedFirstLoad(quietPastTheDeadline),
      [FAKE_SELF_TEST_ENTRY],
    );

    vi.useFakeTimers();
    try {
      const page = await (await browser.newContext()).newPage();
      const refused = settlementOf(
        gotoWhileLoadProgresses(
          page,
          FAKE_FIRST_LOAD_URL,
          FAKE_SELF_TEST_BOUND_MS,
          Date.now() + deadlineInMs,
        ),
      );
      await vi.advanceTimersByTimeAsync(deadlineInMs - 1);
      expect(
        refused.state,
        'a navigation still inside both its stall window and its deadline is left running',
      ).toBe('pending');

      await vi.advanceTimersByTimeAsync(1);
      expect(
        refused.state,
        `a deadline ${deadlineInMs}ms away, inside the ${FAKE_SELF_TEST_BOUND_MS}ms stall window, must be what refuses the navigation`,
      ).toBe('rejected');
      expect(
        record.navigations,
        'the navigation was issued, so what the deadline ended is a first load that had begun',
      ).toEqual([FAKE_FIRST_LOAD_URL]);
      expect(
        observe.requests(),
        'and the page had issued no request by the time the deadline arrived',
      ).toEqual([]);
      const reason = settledReason(refused);
      expect(
        reason,
        `the refusal must report the first load as one that had begun and not finished: ${reason}`,
      ).toContain(`first load of ${FAKE_FIRST_LOAD_URL} had not finished`);
      expect(
        reason,
        `a first load that had issued no request made no network progress, so its refusal at the deadline must not claim it was still making some: ${reason}`,
      ).not.toMatch(/making network progress/);
    } finally {
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });

  test('the fake first-load page settles a failing request with a requestfailed alone, on the page and its context, and reports the failure on it', async () => {
    vi.useFakeTimers();
    try {
      const failingFirst = fakeFirstLoadBrowser({ ...SELF_TEST_FIRST_LOAD, failing: 1 }, [
        FAKE_SELF_TEST_ENTRY,
      ]);
      const context = await failingFirst.browser.newContext();
      const page = await context.newPage();
      const pageEvents: string[] = [];
      const contextEvents: string[] = [];
      const failedRequests: unknown[] = [];
      const finishedRequests: unknown[] = [];
      for (const event of FAKE_PAGE_EVENTS) page.on(event, () => pageEvents.push(event));
      for (const event of FAKE_CONTEXT_EVENTS) context.on(event, () => contextEvents.push(event));
      page.on('requestfailed', (request) => failedRequests.push(request));
      page.on('requestfinished', (request) => finishedRequests.push(request));
      const loaded = settlementOf(page.goto(FAKE_FIRST_LOAD_URL, { timeout: 0 }));
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_REQUESTS * FAKE_SELF_TEST_SPACING_MS);

      expect(
        loaded.state,
        'a load whose failed request settled still reaches load once every request has settled',
      ).toBe('resolved');
      expect(
        pageEvents,
        'a failing request is issued like any other and settles with a requestfailed, with no response and no requestfinished, while the next one completes as before',
      ).toEqual([
        'request',
        'response',
        'requestfinished',
        'request',
        'request',
        'requestfailed',
        'response',
        'requestfinished',
        'domcontentloaded',
        'load',
      ]);
      expect(contextEvents, 'the context hears the requestfailed its page emits').toEqual([
        'request',
        'response',
        'requestfinished',
        'request',
        'request',
        'requestfailed',
        'response',
        'requestfinished',
      ]);
      expect(failingFirst.record.requestsFailed).toBe(1);
      expect(failingFirst.record.requestsCompleted).toBe(FAKE_SELF_TEST_REQUESTS - 1);

      const [failed] = failedRequests as Array<{
        url(): string;
        failure(): unknown;
        response(): Promise<unknown>;
      }>;
      expect(failed?.url(), 'the request that failed is the first module request').toBe(
        fakeModuleUrl(FAKE_FIRST_LOAD_URL, 0),
      );
      expect(
        failed?.failure(),
        "a request playwright reports as failed carries its failure's error text",
      ).toEqual({ errorText: FAKE_REQUEST_FAILURE_TEXT });
      expect(await failed?.response(), 'and has no response to return').toBeNull();
      expect(
        (finishedRequests as Array<{ failure(): unknown }>).map((request) => request.failure()),
        'the adjacent must-not-fire: a request that finished reports no failure',
      ).toEqual([null, null]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a first load whose requests keep failing is still progressing, and its stall refusal counts the failures and names none of them as outstanding', async () => {
    const budget = await declaredFirstLoadBudget();
    const spacingMs = firstLoadCompleting(budget, 0).completionSpacingMs;
    const failing = Math.ceil(
      (budget.navigationReserveMs * PROGRESS_PAST_RESERVE_FACTOR) / spacingMs,
    );
    const { browser, record, observe } = fakeFirstLoadBrowser(
      { ...firstLoadCompleting(budget, failing), failing },
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const { startedAt, settlement } = startedWarmup(budget, browser);
      await vi.advanceTimersByTimeAsync(failing * spacingMs);

      expect(
        settlement.state,
        `the warmup was ${describeSettlement(settlement, startedAt)} while its load was still failing a request every ${spacingMs}ms. A failed request has settled, so a load that keeps settling requests is still making progress`,
      ).toBe('pending');
      expect(
        record.requestsFailed,
        'the load must have failed every request it scripted to fail',
      ).toBe(failing);
      expect(
        record.requestsCompleted,
        'and completed none, so failures were its only progress',
      ).toBe(0);

      await vi.advanceTimersByTimeAsync(budget.navigationReserveMs - 1);
      expect(
        settlement.state,
        `the first load that stopped after ${failing} failures was ${describeSettlement(settlement, startedAt)}, so there is no refusal whose reason this test can read`,
      ).toBe('rejected');
      const reason =
        settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
      const moduleUrls = Array.from({ length: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS }, (_, index) =>
        fakeModuleUrl(FAKE_FIRST_LOAD_URL, index),
      );
      const failedUrls = moduleUrls.slice(0, failing);
      const outstandingUrls = moduleUrls.slice(failing);

      expect(
        reason,
        `a stall refusal must count the ${failing} requests that failed, so a refused warmup says how its load settled: ${reason}`,
      ).toMatch(standaloneNumber(failing));
      expect(
        reason,
        `a failed request has settled, so a stall refusal must count only the ${outstandingUrls.length} requests still outstanding: ${reason}`,
      ).toMatch(standaloneNumber(outstandingUrls.length));
      expect(
        outstandingUrls.filter((url) => reason.includes(url)).length,
        `a stall refusal must name at least one request still outstanding, and this one names none: ${reason}`,
      ).toBeGreaterThan(0);
      expect(
        failedUrls.filter((url) => reason.includes(url)),
        'a request that failed is not named as one the load was still waiting on',
      ).toEqual([]);
    } finally {
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });
});

const RECORDED_CROSSING_TIMELINE_PATH = join(
  dirname(import.meta.filename),
  'fixtures',
  'first-load-crossing-timeline.json',
);

const CONFORMANCE_TIMELINE: FirstLoadTimeline = {
  loadAtMs: 300,
  document: [0, 10],
  requests: [
    [20, 100],
    [30, 500],
  ],
};

function isRequestTiming(value: unknown): value is RecordedRequestTiming {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)
  );
}

function firstLoadTimeline(value: unknown): FirstLoadTimeline {
  const candidate = value as Partial<Record<keyof FirstLoadTimeline, unknown>> | null;
  const loadAtMs = candidate?.loadAtMs;
  if (typeof loadAtMs !== 'number' || !Number.isFinite(loadAtMs) || loadAtMs <= 0) {
    throw new Error(
      `a recorded first-load timeline needs a positive loadAtMs, not ${String(loadAtMs)}`,
    );
  }
  const rows = [
    candidate?.document,
    ...(Array.isArray(candidate?.requests) ? candidate.requests : []),
  ];
  if (!Array.isArray(candidate?.requests) || candidate.requests.length === 0) {
    throw new Error('a recorded first-load timeline must carry at least one subresource request');
  }
  for (const [index, row] of rows.entries()) {
    const label = index === 0 ? 'the document' : `request ${index - 1}`;
    if (!isRequestTiming(row)) {
      throw new Error(
        `${label} of the recorded first-load timeline is not an [issuedAtMs, settledAtMs] pair of non-negative millisecond offsets: ${JSON.stringify(row)}`,
      );
    }
    const [issuedAtMs, settledAtMs] = row;
    if (settledAtMs < issuedAtMs) {
      throw new Error(
        `${label} of the recorded first-load timeline settles before it is issued (${issuedAtMs}ms, then ${settledAtMs}ms), so the recording was extracted wrongly`,
      );
    }
    if (issuedAtMs >= loadAtMs) {
      throw new Error(
        `${label} of the recorded first-load timeline is issued at ${issuedAtMs}ms, at or after the ${loadAtMs}ms load it is meant to precede`,
      );
    }
  }
  return {
    loadAtMs,
    document: candidate?.document as RecordedRequestTiming,
    requests: candidate.requests as RecordedRequestTiming[],
  };
}

function recordedFirstLoad(timeline: FirstLoadTimeline): RecordedFirstLoadScript {
  return { timeline };
}

describe('worker-server fixture first-load warmup liveness against a recorded load', () => {
  test('the fake replays a recorded first-load timeline in recorded order and fires load at its recorded instant, whatever settles after it', async () => {
    vi.useFakeTimers();
    try {
      const recorded = fakeFirstLoadBrowser(recordedFirstLoad(CONFORMANCE_TIMELINE), [
        FAKE_SELF_TEST_ENTRY,
      ]);
      const page = await (await recorded.browser.newContext()).newPage();
      const pageEvents: string[] = [];
      for (const event of FAKE_PAGE_EVENTS) page.on(event, () => pageEvents.push(event));
      const startedAt = Date.now();
      const replayed = settlementOf(page.goto(FAKE_FIRST_LOAD_URL, { timeout: 0 }));
      await vi.advanceTimersByTimeAsync(CONFORMANCE_TIMELINE.loadAtMs - 1);
      expect(replayed.state, 'a replayed load has not fired before its recorded load instant').toBe(
        'pending',
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(
        replayed.state,
        'a replayed load fires at its recorded load instant even while a request it recorded is still outstanding',
      ).toBe('resolved');
      expect(recorded.record.loadedAt).toBe(startedAt + CONFORMANCE_TIMELINE.loadAtMs);
      expect(
        pageEvents,
        'each recorded request is issued at its issue offset and completes as a response then a requestfinished at its settle offset, and the load events fall at the recorded load instant',
      ).toEqual([
        'request',
        'response',
        'requestfinished',
        'request',
        'request',
        'response',
        'requestfinished',
        'domcontentloaded',
        'load',
      ]);
      const [, lateSettleMs] = CONFORMANCE_TIMELINE.requests[1] as RecordedRequestTiming;
      await vi.advanceTimersByTimeAsync(lateSettleMs - CONFORMANCE_TIMELINE.loadAtMs);
      expect(
        pageEvents.slice(-2),
        'a request the recording settled after load still settles, at its own recorded offset',
      ).toEqual(['response', 'requestfinished']);
      expect(recorded.record.requestsCompleted).toBe(CONFORMANCE_TIMELINE.requests.length);

      const settledEarly: FirstLoadTimeline = {
        ...CONFORMANCE_TIMELINE,
        requests: [
          [20, 100],
          [30, 120],
        ],
      };
      const early = fakeFirstLoadBrowser(recordedFirstLoad(settledEarly), [FAKE_SELF_TEST_ENTRY]);
      const earlyPage = await (await early.browser.newContext()).newPage();
      const earlyLoad = settlementOf(earlyPage.goto(FAKE_FIRST_LOAD_URL, { timeout: 0 }));
      await vi.advanceTimersByTimeAsync(settledEarly.loadAtMs - 1);
      expect(
        early.record.requestsCompleted,
        'the adjacent control has settled every request it recorded well before load',
      ).toBe(settledEarly.requests.length);
      expect(
        earlyLoad.state,
        'the adjacent must-not-fire: a replay whose requests all settled early still does not fire load before its recorded instant',
      ).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(earlyLoad.state).toBe('resolved');

      expect(
        firstLoadTimeline(CONFORMANCE_TIMELINE),
        'the must-not-fire control: a well-formed timeline loads unchanged',
      ).toEqual(CONFORMANCE_TIMELINE);
      expect(
        firstLoadTimeline({ ...CONFORMANCE_TIMELINE, requests: [[50, 50]] }).requests,
        'the adjacent must-not-fire: a request settling in the millisecond it was issued is a real recording',
      ).toEqual([[50, 50]]);
      expect(
        () => firstLoadTimeline({ ...CONFORMANCE_TIMELINE, requests: [[50, 49]] }),
        'the planted drift: a row that settles before it is issued is refused by name',
      ).toThrow(/settles before it is issued/);
      expect(
        () =>
          firstLoadTimeline({
            ...CONFORMANCE_TIMELINE,
            requests: [[CONFORMANCE_TIMELINE.loadAtMs, CONFORMANCE_TIMELINE.loadAtMs]],
          }),
        'a row issued at the load instant is outside the window the recording was extracted from',
      ).toThrow(/at or after the/);
      expect(
        () => firstLoadTimeline({ ...CONFORMANCE_TIMELINE, requests: [] }),
        'a timeline with no subresource requests replays nothing a stall window could be judged against',
      ).toThrow(/at least one subresource request/);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the recorded first load that crossed the fixed navigation bound is admitted by the stall window', async () => {
    const budget = await declaredFirstLoadBudget();
    const timeline = firstLoadTimeline(
      JSON.parse(readFileSync(RECORDED_CROSSING_TIMELINE_PATH, 'utf-8')),
    );
    expect(
      timeline.loadAtMs,
      `the replayed recording must be a first load that outran the ${budget.navigationReserveMs}ms navigation share, or admitting it would not show the stall window admits what the fixed bound refused`,
    ).toBeGreaterThan(budget.navigationReserveMs);
    const settledByLoad = timeline.requests.filter(
      ([, settledAtMs]) => settledAtMs <= timeline.loadAtMs,
    ).length;
    const { browser, record } = fakeFirstLoadBrowser(
      recordedFirstLoad(timeline),
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const settlement = settlementOf(
        budget.warmup(
          browser,
          FAKE_FIRST_LOAD_BASE_URL,
          budget.openPhase(FIRST_LOAD_PHASE_NAME, budget.setupOverheadReserveMs),
        ),
      );
      await vi.advanceTimersByTimeAsync(timeline.loadAtMs + budget.visibleReserveMs);

      expect(record.navigations).toEqual([FAKE_FIRST_LOAD_URL]);
      expect(
        settlement.state,
        `the recorded first load that crossed the fixed bound was ${describeSettlement(settlement, startedAt)}. It kept making network progress until its load at ${timeline.loadAtMs}ms, so a bound that refuses only a stalled load must admit it`,
      ).toBe('resolved');
      expect(
        record.loadedAt === undefined ? undefined : record.loadedAt - startedAt,
        'the replay must reach load at the load offset the recording carries, or it replayed a different load than the one recorded',
      ).toBe(timeline.loadAtMs);
      expect(record.requestsIssued).toBe(timeline.requests.length);
      expect(
        record.requestsCompleted,
        'every request the recording settled by its load had settled when the warmup was admitted',
      ).toBe(settledByLoad);
      expect(record.visibleWaits).toHaveLength(1);
      expect(record.contextsClosed).toBe(record.contextsOpened);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a stall refusal while nothing is outstanding reads as complete, without introducing a list of outstanding requests it cannot give', async () => {
    const budget = await declaredFirstLoadBudget();
    const stallMs = await declaredFirstLoadStallMs(budget.navigationReserveMs);
    const lastSettledAtMs = Math.max(
      ...CONFORMANCE_TIMELINE.requests.map(([, settledAtMs]) => settledAtMs),
    );
    const heldLoad: FirstLoadTimeline = {
      ...CONFORMANCE_TIMELINE,
      loadAtMs: lastSettledAtMs + budget.navigationReserveMs,
    };
    const { browser, observe } = fakeFirstLoadBrowser(
      recordedFirstLoad(heldLoad),
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const { startedAt, settlement } = startedWarmup(budget, browser);
      await vi.advanceTimersByTimeAsync(heldLoad.loadAtMs - 1);

      expect(
        settlement.state,
        `a load that settled every request and then went ${budget.navigationReserveMs}ms without firing load was ${describeSettlement(settlement, startedAt)}, so there is no refusal whose reason this test can read`,
      ).toBe('rejected');
      expect(
        observe.requests().filter((request) => !request.completed),
        'the stall under test is one with every request settled and nothing outstanding',
      ).toEqual([]);
      const reason =
        settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
      expect(
        reason,
        `the refusal read here must be the stall refusal, naming the ${stallMs}ms window it waited: ${reason}`,
      ).toMatch(standaloneNumber(stallMs));
      expect(
        reason,
        `a stall refusal with nothing outstanding must not trail off into a list of outstanding requests it cannot give: ${reason}`,
      ).not.toMatch(/including\s*$/);
    } finally {
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });
});

const MISSING_DEADLINES = [undefined, Number.NaN, Number.POSITIVE_INFINITY] as const;

function settledReason(settlement: Settlement): string {
  return settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
}

function refusalWording(reason: string): string {
  return reason.replaceAll(FAKE_FIRST_LOAD_BASE_URL, '<origin>').replace(/\d+/g, '<n>');
}

function expectRefusalNamesStarvationLine(
  reason: string,
  budget: DeclaredFirstLoadBudget,
  refused: string,
): void {
  expect(
    reason,
    `${refused} must say the deadline that ended it is the fixture's ${budget.starvationLineMs}ms setup starvation line, or whoever reads the failure has to find in the fixture's source what the deadline was: ${reason}`,
  ).toMatch(new RegExp(`${budget.starvationLineMs}ms setup starvation line`));
  expect(
    reason,
    `${refused} must place that line in the fixture's ${budget.totalMs}ms slot, as the fixture's own starvation refusal does: ${reason}`,
  ).toMatch(standaloneNumber(budget.totalMs));
}

const CONTEXT_CLOSE_FAILURE =
  'browserContext.close: the context this scenario asked to close reported a failure';

function closeFailingBrowser(browser: FakeBrowser): FakeBrowser {
  return {
    newContext: async (options?: unknown) => {
      const context = await browser.newContext(options);
      return new Proxy(context, {
        get: (target, key, receiver) =>
          key === 'close'
            ? async () => {
                await target.close();
                throw new Error(CONTEXT_CLOSE_FAILURE);
              }
            : Reflect.get(target, key, receiver),
      });
    },
  };
}

interface DeadlineLegScene {
  budget: DeclaredFirstLoadBudget;
  record: FirstLoadRecord;
  observe: FirstLoadObserver;
  startedAt: number;
}

interface DeadlineLeg {
  leg: string;
  holds: FakeHolds;
  rendersTree: boolean;
  settlesAs: readonly Settlement['state'][];
  expectReached(scene: DeadlineLegScene): void;
  expectReleased?(scene: DeadlineLegScene): void;
}

function expectWaitingOnTheHeldContext({ record, observe }: DeadlineLegScene): void {
  expect(
    observe.held(),
    'the warmup must be waiting on the browser context this scenario holds, or something other than the held leg is what the line ends',
  ).toEqual([HELD_NEW_CONTEXT]);
  expect(record.navigations, 'and must not have got as far as navigating').toEqual([]);
}

const DEADLINE_LEGS: readonly DeadlineLeg[] = [
  {
    leg: 'a browser context it asks for and never gets',
    holds: { newContext: 'rejected-when-released' },
    rendersTree: true,
    settlesAs: ['rejected'],
    expectReached: expectWaitingOnTheHeldContext,
  },
  {
    leg: 'a browser context it asks for and is handed only after the line',
    holds: { newContext: 'handed-back-when-released' },
    rendersTree: true,
    settlesAs: ['rejected'],
    expectReached: expectWaitingOnTheHeldContext,
    expectReleased: ({ record, observe }) => {
      expect(
        observe.contexts.length,
        'releasing the held call must hand back the context the warmup asked for, or there is no late context whose fate this leg can read',
      ).toBe(1);
      expect(record.contextsOpened, 'the one context the warmup asked the browser for').toBe(1);
      expect(
        record.contextsClosed,
        "a context the browser hands back after the warmup was refused at the line must be closed by the warmup that asked for it, before anything else closes one, or it stays open on the worker's browser until the worker shuts down",
      ).toBe(1);
    },
  },
  {
    leg: 'a page it asks for and never gets',
    holds: { newPage: true },
    rendersTree: true,
    settlesAs: ['rejected'],
    expectReached: ({ record, observe }) => {
      expect(
        observe.held(),
        'the warmup must be waiting on the page this scenario holds, or something other than the held leg is what the line ends',
      ).toEqual([HELD_NEW_PAGE]);
      expect(record.navigations, 'and must not have got as far as navigating').toEqual([]);
    },
  },
  {
    leg: 'a tree wait whose own bound runs past the line',
    holds: {},
    rendersTree: false,
    settlesAs: ['rejected'],
    expectReached: ({ budget, record, startedAt }) => {
      expect(
        record.visibleWaits,
        'the warmup must be waiting for the tree entry this load never renders',
      ).toEqual([budget.renderedEntryNames[0]]);
      const loadedAfterMs = (record.loadedAt as number) - startedAt;
      expect(
        loadedAfterMs + budget.visibleReserveMs,
        `the tree wait began ${loadedAfterMs}ms in, so its own ${budget.visibleReserveMs}ms bound runs past the ${budget.starvationLineMs}ms line and only the line can end it there`,
      ).toBeGreaterThan(budget.starvationLineMs);
    },
  },
  {
    leg: 'a context close that never returns',
    holds: { contextClose: true },
    rendersTree: true,
    settlesAs: ['resolved', 'rejected'],
    expectReached: ({ budget, record, observe }) => {
      expect(
        record.visibleWaits,
        'the load must have been admitted and its tree waited for before the close',
      ).toEqual([budget.renderedEntryNames[0]]);
      expect(
        observe.held(),
        'the warmup must be waiting on the context close this scenario holds, or something other than the held leg is what the line ends',
      ).toEqual([HELD_CONTEXT_CLOSE]);
    },
  },
];

describe('worker-server fixture first-load warmup liveness up to the starvation line', () => {
  test('the fake first-load browser holds exactly the calls it is told to hold, until they are released or their context closes', async () => {
    vi.useFakeTimers();
    try {
      const free = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [FAKE_SELF_TEST_ENTRY]);
      const freeContext = settlementOf(free.browser.newContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(
        freeContext.state,
        'the must-not-fire control: a browser told to hold nothing hands back its context',
      ).toBe('resolved');
      expect(free.observe.held()).toEqual([]);

      const heldContext = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [FAKE_SELF_TEST_ENTRY], {
        newContext: 'rejected-when-released',
      });
      const asked = settlementOf(heldContext.browser.newContext());
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_BOUND_MS * FAKE_SELF_TEST_SPACING_MS);
      expect(asked.state, 'a held context is never handed back, however far the clock runs').toBe(
        'pending',
      );
      expect(
        heldContext.record.contextsOpened,
        'the held call is still recorded as asked for',
      ).toBe(1);
      expect(heldContext.observe.held()).toEqual([HELD_NEW_CONTEXT]);
      heldContext.observe.releaseHeld();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        asked.state,
        'releasing a held context rejects it, as a browser that goes away would',
      ).toBe('rejected');
      expect(heldContext.observe.held()).toEqual([]);
      expect(
        heldContext.observe.contexts.length,
        'and a context it rejects is never registered as one the browser handed back',
      ).toBe(0);

      const lateContext = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [FAKE_SELF_TEST_ENTRY], {
        newContext: 'handed-back-when-released',
      });
      const askedLate = lateContext.browser.newContext();
      const late = settlementOf(askedLate);
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_BOUND_MS * FAKE_SELF_TEST_SPACING_MS);
      expect(
        late.state,
        'a context held to be handed back late is not handed back before its release, however far the clock runs',
      ).toBe('pending');
      expect(
        lateContext.observe.contexts.length,
        'and is not registered as a live context before then',
      ).toBe(0);
      expect(lateContext.observe.held()).toEqual([HELD_NEW_CONTEXT]);
      lateContext.observe.releaseHeld();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        late.state,
        'releasing it hands the context back, as a browser that was only slow would',
      ).toBe('resolved');
      expect(lateContext.observe.held()).toEqual([]);
      const handedBack = await askedLate;
      expect(
        lateContext.observe.contexts.length === 1 && lateContext.observe.contexts[0] === handedBack,
        'the context handed back late is registered like one handed back at once',
      ).toBe(true);
      expect(
        lateContext.record.contextsOpened,
        'the late call is recorded once, as asked for',
      ).toBe(1);
      await handedBack.close();
      expect(
        lateContext.record.contextsClosed,
        'and it is a live context, whose close is recorded like any other',
      ).toBe(1);

      const heldPage = fakeFirstLoadBrowser(SELF_TEST_FIRST_LOAD, [FAKE_SELF_TEST_ENTRY], {
        newPage: true,
      });
      const pageContext = settlementOf(heldPage.browser.newContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(
        pageContext.state,
        'the adjacent must-not-fire control: holding pages does not hold the context they open in',
      ).toBe('resolved');
      const context = heldPage.observe.contexts[0] as FakeContext;
      const page = settlementOf(context.newPage());
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_BOUND_MS * FAKE_SELF_TEST_SPACING_MS);
      expect(page.state, 'a held page is never handed back, however far the clock runs').toBe(
        'pending',
      );
      expect(heldPage.observe.held()).toEqual([HELD_NEW_PAGE]);
      await context.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        page.state,
        'closing the context rejects the page still pending in it, as playwright does, so a warmup that ends a held page by closing its context is not failed by the fake',
      ).toBe('rejected');
      expect(heldPage.observe.held()).toEqual([]);

      const heldClose = fakeFirstLoadBrowser(
        { ...SELF_TEST_FIRST_LOAD, completing: 0 },
        [FAKE_SELF_TEST_ENTRY],
        { contextClose: true },
      );
      const closingContext = await heldClose.browser.newContext();
      const pageRequest = closingContext.newPage();
      const closingPage = settlementOf(pageRequest);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        closingPage.state,
        'the adjacent must-not-fire control: holding the close does not hold the page',
      ).toBe('resolved');
      const navigation = settlementOf(
        (await pageRequest).goto(FAKE_FIRST_LOAD_URL, { timeout: 0 }),
      );
      const closing = settlementOf(closingContext.close());
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_BOUND_MS * FAKE_SELF_TEST_SPACING_MS);
      expect(closing.state, 'a held close never returns, however far the clock runs').toBe(
        'pending',
      );
      expect(
        heldClose.record.listeningAtContextClose.length,
        'the held close is still recorded as asked for',
      ).toBe(1);
      expect(heldClose.record.contextsClosed, 'and leaves its context open').toBe(0);
      expect(navigation.state, 'so a navigation inside it keeps running').toBe('pending');
      expect(heldClose.observe.held()).toEqual([HELD_CONTEXT_CLOSE]);
      heldClose.observe.releaseHeld();
      await vi.advanceTimersByTimeAsync(0);
      expect(closing.state, 'releasing a held close completes it').toBe('resolved');
      expect(heldClose.record.contextsClosed).toBe(1);
      expect(navigation.state, 'and ends the navigation inside it').toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });

  test("a first load still making progress at the fixture's starvation line is refused there by the warmup, naming what it was still waiting on", async () => {
    const budget = await declaredFirstLoadBudget();
    const spacingMs = spacingOutlasting(budget.totalMs + budget.navigationReserveMs);
    const { browser, record, observe } = fakeFirstLoadBrowser(
      {
        requests: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
        completionSpacingMs: spacingMs,
        completing: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
      },
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const { startedAt, settlement } = startedWarmup(budget, browser);
      await vi.advanceTimersByTimeAsync(budget.starvationLineMs - 1);

      expect(record.navigations).toEqual([FAKE_FIRST_LOAD_URL]);
      expect(
        settlement.state,
        `a first load still completing a request every ${spacingMs}ms was ${describeSettlement(settlement, startedAt)} one millisecond before the fixture's ${budget.starvationLineMs}ms starvation line. Up to the line a load that is making progress is admitted`,
      ).toBe('pending');
      const progressedToMs = (record.lastProgressAt as number) - startedAt;
      expect(
        progressedToMs,
        `the load must have kept making progress past the ${budget.navigationReserveMs}ms navigation share`,
      ).toBeGreaterThan(budget.navigationReserveMs);
      expect(
        budget.starvationLineMs - 1 - progressedToMs,
        `and must still be making progress at the line, its last completion less than one ${spacingMs}ms gap before it`,
      ).toBeLessThan(spacingMs);
      expect(record.requestsCompleted, 'with requests of its load still outstanding').toBeLessThan(
        OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
      );

      await vi.advanceTimersByTimeAsync(1);
      expect(
        settlement.state,
        `a first load still completing a request every ${spacingMs}ms reached the fixture's ${budget.starvationLineMs}ms starvation line and was ${describeSettlement(settlement, startedAt)}. The warmup must refuse it there, so the failure reaches the fixture's own catch, which reaps the detached dev server and removes its dirs while setup is still live. Left running, it is ended by the registered ${budget.totalMs}ms slot instead, which skips the fixture's teardown and never awaits that reap`,
      ).toBe('rejected');
      const reason = settledReason(settlement);
      const outstanding = observe.requests().filter((request) => !request.completed);
      const completedModules = observe
        .requests()
        .filter(
          (request) => request.completed && request.resourceType === FAKE_SCRIPT_RESOURCE_TYPE,
        );
      expect(
        outstanding.length,
        'every module request the load had not completed by the line is outstanding',
      ).toBe(OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS - record.requestsCompleted);
      expect(
        reason,
        `a first load refused at the line must say how many requests were still outstanding (${outstanding.length}), as a stall refusal does, so the failure the fixture reports says what the load was still waiting on: ${reason}`,
      ).toMatch(standaloneNumber(outstanding.length));
      expect(
        outstanding.filter((request) => reason.includes(request.url)).length,
        `a first load refused at the line must name at least one request still outstanding, and this one names none: ${reason}`,
      ).toBeGreaterThan(0);
      expect(
        completedModules
          .filter((request) => reason.includes(request.url))
          .map((request) => request.url),
        'a request that completed is not named as one the load was still waiting on',
      ).toEqual([]);
      expectRefusalNamesStarvationLine(reason, budget, 'a first load refused at the line');
      expect(
        record.listeningAtContextClose.length,
        'the warmup must have asked to close its context once after the refusal, or the browser keeps loading from a dev server the catch is about to reap',
      ).toBe(1);
      expect(
        record.listeningAtContextClose,
        'with nothing the navigation attached still listening',
      ).toEqual([[]]);
      expect(
        observe.timersBeyondPages(),
        'a refusal at the line must leave nothing armed behind it, or that timer fires into a fixture that has already failed',
      ).toBe(0);

      const stalled = fakeFirstLoadBrowser(
        firstLoadCompleting(budget, 0),
        budget.renderedEntryNames,
      );
      const stall = startedWarmup(budget, stalled.browser);
      await vi.advanceTimersByTimeAsync(budget.navigationReserveMs - 1);
      expect(
        stall.settlement.state,
        'the comparison load, which never completes a request, must have been refused as stalled',
      ).toBe('rejected');
      expect(
        refusalWording(reason),
        `a first load refused at the line while it was still making progress must not be reported in the words the same warmup uses for a stall, or the failure blames a load that never went quiet: ${reason}`,
      ).not.toBe(refusalWording(settledReason(stall.settlement)));
      await closeEveryContext(stalled.observe);
    } finally {
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });

  for (const leg of DEADLINE_LEGS) {
    test(`no leg of the warmup runs past the fixture's starvation line: ${leg.leg} is ended there`, async () => {
      const budget = await declaredFirstLoadBudget();
      const { browser, record, observe } = fakeFirstLoadBrowser(
        firstLoadCompleting(budget, OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS),
        leg.rendersTree ? budget.renderedEntryNames : [],
        leg.holds,
      );

      vi.useFakeTimers();
      try {
        const { startedAt, settlement } = startedWarmup(budget, browser);
        await vi.advanceTimersByTimeAsync(budget.starvationLineMs - 1);
        leg.expectReached({ budget, record, observe, startedAt });

        await vi.advanceTimersByTimeAsync(1);
        expect(
          leg.settlesAs,
          `with ${leg.leg}, the warmup was ${describeSettlement(settlement, startedAt)} when the fixture's ${budget.starvationLineMs}ms starvation line arrived. Every leg of the warmup must be over by the line, so the fixture's own catch runs while setup is still live rather than the registered ${budget.totalMs}ms slot ending a fixture whose cleanup nothing then awaits`,
        ).toContain(settlement.state);
        if (settlement.state === 'rejected') {
          expectRefusalNamesStarvationLine(
            settledReason(settlement),
            budget,
            `a warmup refused at the line with ${leg.leg}`,
          );
        }

        observe.releaseHeld();
        await vi.advanceTimersByTimeAsync(0);
        leg.expectReleased?.({ budget, record, observe, startedAt });
      } finally {
        observe.releaseHeld();
        await closeEveryContext(observe);
        vi.useRealTimers();
      }
    });
  }

  test('the warmup refuses a missing or unbounded deadline before it asks for a context, and runs to completion before a real one', async () => {
    const budget = await declaredFirstLoadBudget();

    vi.useFakeTimers();
    try {
      for (const deadlineAt of MISSING_DEADLINES) {
        const { browser, record, observe } = fakeFirstLoadBrowser(
          SELF_TEST_FIRST_LOAD,
          budget.renderedEntryNames,
        );
        let thrown: unknown;
        let returned: Promise<void> | undefined;
        try {
          returned = budget.warmupBefore(
            browser,
            FAKE_FIRST_LOAD_BASE_URL,
            budget.openPhase(FIRST_LOAD_PHASE_NAME, budget.setupOverheadReserveMs),
            deadlineAt as number,
          );
        } catch (err) {
          thrown = err;
        }
        expect(
          thrown,
          `a deadline of ${String(deadlineAt)} must be refused through the promise ${WARMUP_FIRST_LOAD_EXPORT} returns, not thrown before it returns one`,
        ).toBeUndefined();
        const refused = settlementOf(returned ?? Promise.resolve());
        await vi.advanceTimersByTimeAsync(0);

        expect(
          refused.state,
          `a deadline of ${String(deadlineAt)} must be refused at once. A required deadline leaves the warmup no unbounded mode, and one that runs without it is a first load the fixture's catch cannot end before the registered slot does`,
        ).toBe('rejected');
        expect(refused.reason).toBeInstanceOf(TypeError);
        expect(settledReason(refused)).toMatch(new RegExp(WARMUP_FIRST_LOAD_EXPORT));
        expect(
          settledReason(refused),
          `a deadline is the instant ${WARMUP_FIRST_LOAD_EXPORT} has to finish by, not a bound it spends, so its refusal must name it as one or a caller who passed a duration reads that it passed the right kind of value`,
        ).toMatch(new RegExp(`${WARMUP_FIRST_LOAD_EXPORT} needs its caller to name the instant`));
        expect(
          record.contextsOpened,
          'a warmup refused for its missing deadline must not have asked the browser for a context',
        ).toBe(0);
        observe.releaseHeld();
        await closeEveryContext(observe);
      }

      const { browser, record, observe } = fakeFirstLoadBrowser(
        SELF_TEST_FIRST_LOAD,
        budget.renderedEntryNames,
      );
      const admitted = settlementOf(
        budget.warmupBefore(
          browser,
          FAKE_FIRST_LOAD_BASE_URL,
          budget.openPhase(FIRST_LOAD_PHASE_NAME, budget.setupOverheadReserveMs),
          Date.now() + budget.starvationLineMs,
        ),
      );
      await vi.advanceTimersByTimeAsync(FAKE_SELF_TEST_REQUESTS * FAKE_SELF_TEST_SPACING_MS);
      expect(
        admitted.state,
        'the adjacent control: a finite deadline the load finishes well inside is run to completion',
      ).toBe('resolved');
      expect(record.navigations).toEqual([FAKE_FIRST_LOAD_URL]);
      expect(record.visibleWaits).toEqual([budget.renderedEntryNames[0]]);
      expect(record.contextsClosed).toBe(1);
      expect(
        observe.listening(),
        'an admitted warmup must release every listener it attached',
      ).toEqual([[]]);
      expect(
        observe.timersBeyondPages(),
        'a warmup that finished before its deadline must leave nothing armed against it, or that timer fires into a fixture that has moved on',
      ).toBe(0);
      await closeEveryContext(observe);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a warmup handed a deadline that has already passed asks for no browser context, and says the leg it would have started was not started', async () => {
    const budget = await declaredFirstLoadBudget();
    const { browser, record, observe } = fakeFirstLoadBrowser(
      SELF_TEST_FIRST_LOAD,
      budget.renderedEntryNames,
    );

    vi.useFakeTimers();
    try {
      const refused = settlementOf(
        budget.warmupBefore(
          browser,
          FAKE_FIRST_LOAD_BASE_URL,
          budget.openPhase(FIRST_LOAD_PHASE_NAME, budget.setupOverheadReserveMs),
          Date.now() - 1,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(
        refused.state,
        'a deadline a millisecond behind the clock is a real instant that has passed, so the warmup must refuse at once rather than start its first leg',
      ).toBe('rejected');
      const reason = settledReason(refused);
      expect(
        reason,
        `the refusal must name the leg it did not start and say it was not started, not that it did not settle, or it reports browser work that never ran: ${reason}`,
      ).toMatch(/browser\.newContext was not started/);
      expectRefusalNamesStarvationLine(reason, budget, 'a warmup that began past its deadline');
      expect(
        record.contextsOpened,
        'a warmup whose deadline had already passed must not have asked the browser for a context, which nothing would then close',
      ).toBe(0);
    } finally {
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });

  test('a context close that fails after the warmup was refused neither replaces the refusal nor goes unreported, before the line or at it', async () => {
    const budget = await declaredFirstLoadBudget();
    const scenarios = [
      {
        refusal: 'a stall',
        script: firstLoadCompleting(budget, 0),
        refusedWithinMs: budget.navigationReserveMs - 1,
      },
      {
        refusal: "the fixture's starvation line",
        script: {
          requests: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
          completionSpacingMs: spacingOutlasting(budget.totalMs + budget.navigationReserveMs),
          completing: OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS,
        },
        refusedWithinMs: budget.starvationLineMs,
      },
    ];

    for (const { refusal, script, refusedWithinMs } of scenarios) {
      const { browser, record, observe } = fakeFirstLoadBrowser(script, budget.renderedEntryNames);
      const warned: string[] = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
        warned.push(String(line));
      });
      vi.useFakeTimers();
      try {
        const { startedAt, settlement } = startedWarmup(budget, closeFailingBrowser(browser));
        await vi.advanceTimersByTimeAsync(refusedWithinMs);
        await vi.advanceTimersByTimeAsync(0);

        expect(
          settlement.state,
          `the first load refused by ${refusal} was ${describeSettlement(settlement, startedAt)}, so there is no refusal whose fate this test can read`,
        ).toBe('rejected');
        expect(
          record.listeningAtContextClose.length,
          `after ${refusal} the warmup must have asked to close its context once, or there was no close to fail`,
        ).toBe(1);
        const reason = settledReason(settlement);
        const outstanding = observe.requests().filter((request) => !request.completed).length;
        expect(
          reason,
          `the warmup's failure after ${refusal} must still be that refusal, naming the ${outstanding} requests the load was waiting on, and not the context close that failed after it: ${reason}`,
        ).toMatch(standaloneNumber(outstanding));
        expect(reason).not.toContain(CONTEXT_CLOSE_FAILURE);
        expect(
          warned.filter((line) => line.includes(CONTEXT_CLOSE_FAILURE)),
          `a context close that failed after ${refusal} must leave a trace, or a context the browser may still hold open drops out of the record`,
        ).toHaveLength(1);
      } finally {
        spy.mockRestore();
        await closeEveryContext(observe);
        vi.useRealTimers();
      }
    }
  });

  test("a context the browser hands back after the warmup was refused at the fixture's starvation line, whose close then fails, is reported rather than dropped", async () => {
    const budget = await declaredFirstLoadBudget();
    const { browser, record, observe } = fakeFirstLoadBrowser(
      firstLoadCompleting(budget, OBSERVED_FIRST_LOAD_SCRIPT_REQUESTS),
      budget.renderedEntryNames,
      { newContext: 'handed-back-when-released' },
    );
    const warned: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warned.push(String(line));
    });
    vi.useFakeTimers();
    try {
      const { startedAt, settlement } = startedWarmup(budget, closeFailingBrowser(browser));
      await vi.advanceTimersByTimeAsync(budget.starvationLineMs);
      expect(
        settlement.state,
        `the warmup still waiting on its browser context at the line was ${describeSettlement(settlement, startedAt)}, so there is no refusal after which a late context can arrive`,
      ).toBe('rejected');
      expect(warned, 'nothing has been closed yet, so nothing has failed to close').toEqual([]);

      observe.releaseHeld();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        record.contextsClosed,
        'the context handed back after the line must have been closed by the warmup, or there was no close to fail',
      ).toBe(1);
      expect(
        warned.filter((line) => line.includes(CONTEXT_CLOSE_FAILURE)),
        'a late context whose close failed must leave a trace, or a context the browser may still hold open drops out of the record',
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
      observe.releaseHeld();
      await closeEveryContext(observe);
      vi.useRealTimers();
    }
  });
});

const WARMUP_DEADLINE_ARGUMENT_INDEX = 3;

type WarmupDeadlineOffset =
  | { kind: 'value'; name: string }
  | { kind: 'call'; name: string; args: readonly string[] };

interface WarmupDeadlineWiring {
  findings: string[];
  offset: WarmupDeadlineOffset | undefined;
}

function unwrappedExpression(node: Node): Node {
  let current = node;
  while (
    current.isKind(SyntaxKind.ParenthesizedExpression) ||
    current.isKind(SyntaxKind.AsExpression) ||
    current.isKind(SyntaxKind.NonNullExpression) ||
    current.isKind(SyntaxKind.SatisfiesExpression)
  ) {
    current = current.getExpression();
  }
  return current;
}

function followedAlias(node: Node, sourceFile: SourceFile, kept: ReadonlySet<string>): Node {
  let current = unwrappedExpression(node);
  const followed = new Set<string>();
  while (current.isKind(SyntaxKind.Identifier)) {
    const name = current.getText();
    if (kept.has(name) || followed.has(name)) break;
    followed.add(name);
    const initializer = namedValueInitializer(sourceFile, name);
    if (initializer === undefined) break;
    current = unwrappedExpression(initializer);
  }
  return current;
}

function readableDeadlineOffset(
  node: Node,
  exported: ReadonlySet<string>,
): WarmupDeadlineOffset | undefined {
  if (node.isKind(SyntaxKind.Identifier)) {
    return exported.has(node.getText()) ? { kind: 'value', name: node.getText() } : undefined;
  }
  if (!node.isKind(SyntaxKind.CallExpression)) return undefined;
  const callee = node.getExpression();
  if (!callee.isKind(SyntaxKind.Identifier) || !exported.has(callee.getText())) return undefined;
  const args = node.getArguments().map(unwrappedExpression);
  if (!args.every((arg) => arg.isKind(SyntaxKind.Identifier) && exported.has(arg.getText()))) {
    return undefined;
  }
  return { kind: 'call', name: callee.getText(), args: args.map((arg) => arg.getText()) };
}

function warmupDeadlineWiring(source: string): WarmupDeadlineWiring {
  const sourceFile = parseBudgetSource(source);
  const body = workerServerFixtureBody(sourceFile);
  if (body === undefined) return { findings: ['scope-missing'], offset: undefined };
  const calls = budgetCallsWithin(body, WARMUP_FIRST_LOAD_EXPORT);
  if (calls.length !== 1) return { findings: ['warmup-call-count'], offset: undefined };
  const call = calls[0] as CallExpression;

  const findings: string[] = [];
  const setupTry = call.getFirstAncestorByKind(SyntaxKind.TryStatement);
  const insideSetupTry =
    setupTry !== undefined &&
    setupTry.getStart() >= body.getStart() &&
    setupTry.getCatchClause() !== undefined &&
    setupTry.getTryBlock().getStart() <= call.getStart() &&
    setupTry.getTryBlock().getEnd() >= call.getEnd();
  if (!insideSetupTry) findings.push('warmup-outside-setup-catch');

  const deadline = call.getArguments()[WARMUP_DEADLINE_ARGUMENT_INDEX];
  if (deadline === undefined)
    return { findings: [...findings, 'deadline-missing'], offset: undefined };

  const exported = new Set(sourceFile.getExportedDeclarations().keys());
  const kept = new Set([...exported, FIXTURE_START_IDENTIFIER]);
  const sum = followedAlias(deadline, sourceFile, kept).asKind(SyntaxKind.BinaryExpression);
  const operands =
    sum !== undefined && sum.getOperatorToken().getKind() === SyntaxKind.PlusToken
      ? [sum.getLeft(), sum.getRight()].map((operand) => followedAlias(operand, sourceFile, kept))
      : [];
  const anchorAt = operands.findIndex(
    (operand) =>
      operand.isKind(SyntaxKind.Identifier) && operand.getText() === FIXTURE_START_IDENTIFIER,
  );
  if (anchorAt === -1) {
    return { findings: [...findings, 'deadline-not-from-fixture-start'], offset: undefined };
  }
  const offset = readableDeadlineOffset(operands[1 - anchorAt] as Node, exported);
  if (offset === undefined) findings.push('deadline-offset-unreadable');
  return { findings, offset };
}

function deadlineOffsetValue(
  offset: WarmupDeadlineOffset | undefined,
  exports: Record<string, unknown>,
): unknown {
  if (offset === undefined) return undefined;
  if (offset.kind === 'value') return exports[offset.name];
  const resolve = exports[offset.name];
  if (typeof resolve !== 'function') return undefined;
  return (resolve as (...args: unknown[]) => unknown)(...offset.args.map((name) => exports[name]));
}

function withoutLiveWarmupDeadline(source: string): string {
  const sourceFile = parseBudgetSource(source);
  const body = workerServerFixtureBody(sourceFile);
  const call =
    body === undefined ? undefined : budgetCallsWithin(body, WARMUP_FIRST_LOAD_EXPORT)[0];
  expect(
    call?.getArguments().length,
    'the live-drift control drops the deadline from the shipped warmup call, so that call must carry one',
  ).toBeGreaterThan(WARMUP_DEADLINE_ARGUMENT_INDEX);
  call?.removeArgument(WARMUP_DEADLINE_ARGUMENT_INDEX);
  return sourceFile.getFullText();
}

const PLANTED_LINE_EXPORT = 'PLANTED_SETUP_STARVATION_LINE_MS';
const PLANTED_LINE_RESOLVER_EXPORT = 'resolvePlantedSetupStarvationLineMs';
const PLANTED_UNEXPORTED_LINE = 'plantedUnexportedStarvationLineMs';
const PLANTED_UNEXPORTED_RESOLVER = 'plantedUnexportedStarvationLineResolver';
const PLANTED_LINE_ALIAS = 'plantedStarvationLineAlias';
const PLANTED_DEADLINE_ALIAS = 'setupDeadlineAt';

const PLANTED_LINE_DECLARATIONS = [
  `export const ${PLANTED_LINE_EXPORT} = ${DECLARED_TOTAL_EXPORT} - ${DECLARED_RESERVES_EXPORT}.${TEARDOWN_RESERVE_KEY};`,
  `export function ${PLANTED_LINE_RESOLVER_EXPORT}(totalMs) {`,
  `  return totalMs - ${DECLARED_RESERVES_EXPORT}.${TEARDOWN_RESERVE_KEY};`,
  '}',
  `const ${PLANTED_UNEXPORTED_LINE} = ${DECLARED_TOTAL_EXPORT} - ${DECLARED_RESERVES_EXPORT}.${TEARDOWN_RESERVE_KEY};`,
  `function ${PLANTED_UNEXPORTED_RESOLVER}(totalMs) {`,
  `  return totalMs - ${DECLARED_RESERVES_EXPORT}.${TEARDOWN_RESERVE_KEY};`,
  '}',
  `const ${PLANTED_LINE_ALIAS} = ${PLANTED_LINE_EXPORT};`,
].join('\n');

const COMPLIANT_DEADLINE = `${FIXTURE_START_IDENTIFIER} + ${PLANTED_LINE_EXPORT}`;
const PLANTED_USE_STATEMENT = '      await use({ port, baseURL, contentDir });';

function plantedDeadlineCall(deadline: string): string {
  return `        await ${WARMUP_FIRST_LOAD_EXPORT}(browser, ${PLANTED_BASE_URL}, setupOverhead, ${deadline});`;
}

function plantedDeadlineSource(deadline?: string): string {
  const withoutDeadline = plantedWarmupWiringSource(PLANTED_LINE_DECLARATIONS);
  if (deadline === undefined) return withoutDeadline;
  return replacedOnce(withoutDeadline, PLANTED_WARMUP_CALL, plantedDeadlineCall(deadline));
}

describe('worker-server fixture first-load warmup liveness wired to the starvation line', () => {
  test('the warmup deadline scan fires on every way the fixture can hand its warmup a deadline other than its starvation line from its start, and stays quiet on the spellings that are one', () => {
    const compliant = warmupDeadlineWiring(plantedDeadlineSource(COMPLIANT_DEADLINE));
    expect(
      compliant,
      'the must-not-fire control: the fixture start plus an exported line, passed to the warmup inside the setup try, is the shape every mutation below departs from',
    ).toEqual({ findings: [], offset: { kind: 'value', name: PLANTED_LINE_EXPORT } });

    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(`${PLANTED_LINE_EXPORT} + ${FIXTURE_START_IDENTIFIER}`),
      ).findings,
      'the adjacent must-not-fire control: the same sum with its operands swapped',
    ).toEqual([]);
    expect(
      warmupDeadlineWiring(
        replacedOnce(
          plantedDeadlineSource(PLANTED_DEADLINE_ALIAS),
          plantedDeadlineCall(PLANTED_DEADLINE_ALIAS),
          `        const ${PLANTED_DEADLINE_ALIAS} = ${COMPLIANT_DEADLINE};\n${plantedDeadlineCall(PLANTED_DEADLINE_ALIAS)}`,
        ),
      ).findings,
      'the adjacent must-not-fire control: the deadline named once in the setup and passed by that name',
    ).toEqual([]);
    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(`${FIXTURE_START_IDENTIFIER} + ${PLANTED_LINE_ALIAS}`),
      ),
      'the adjacent must-not-fire control: a local alias of the exported line is read through to the export',
    ).toEqual({ findings: [], offset: { kind: 'value', name: PLANTED_LINE_EXPORT } });
    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(
          `${FIXTURE_START_IDENTIFIER} + ${PLANTED_LINE_RESOLVER_EXPORT}(${DECLARED_TOTAL_EXPORT})`,
        ),
      ),
      'the adjacent must-not-fire control: an exported resolver called with exported inputs is a line this suite can read',
    ).toEqual({
      findings: [],
      offset: { kind: 'call', name: PLANTED_LINE_RESOLVER_EXPORT, args: [DECLARED_TOTAL_EXPORT] },
    });
    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(`${FIXTURE_START_IDENTIFIER} + ${DECLARED_TOTAL_EXPORT}`),
      ),
      'the scan reads the offset and leaves its value to the live test: the whole slot passes here and is refused there, where the offset is compared with the starvation line',
    ).toEqual({ findings: [], offset: { kind: 'value', name: DECLARED_TOTAL_EXPORT } });

    expect(
      warmupDeadlineWiring(plantedDeadlineSource()).findings,
      'a warmup called without a deadline is the unbounded first load this pin exists to refuse',
    ).toEqual(['deadline-missing']);
    expect(
      warmupDeadlineWiring(plantedDeadlineSource(`Date.now() + ${PLANTED_LINE_EXPORT}`)).findings,
      'a deadline measured from the warmup call rather than from the fixture start gives the warmup the whole line again after readiness has already spent part of it',
    ).toEqual(['deadline-not-from-fixture-start']);
    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(`${FIXTURE_START_IDENTIFIER} - ${PLANTED_LINE_EXPORT}`),
      ).findings,
      'the adjacent must-fire: the same operands under the wrong operator',
    ).toEqual(['deadline-not-from-fixture-start']);
    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(`${FIXTURE_START_IDENTIFIER} + ${REINTRODUCED_LITERAL}`),
      ).findings,
      'a line written at the call site is a number the manifest does not declare',
    ).toEqual(['deadline-offset-unreadable']);
    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(`${FIXTURE_START_IDENTIFIER} + ${PLANTED_UNEXPORTED_LINE}`),
      ).findings,
      'a line derived where this suite cannot read it is a line it cannot compare with the one the starvation refusal draws',
    ).toEqual(['deadline-offset-unreadable']);
    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(
          `${FIXTURE_START_IDENTIFIER} + ${PLANTED_LINE_RESOLVER_EXPORT}(${REINTRODUCED_LITERAL})`,
        ),
      ).findings,
      'the adjacent must-fire: the exported resolver fed a number written at the call site',
    ).toEqual(['deadline-offset-unreadable']);
    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(
          `${FIXTURE_START_IDENTIFIER} + ${PLANTED_UNEXPORTED_RESOLVER}(${DECLARED_TOTAL_EXPORT})`,
        ),
      ).findings,
      'the adjacent must-fire: the same call to a resolver the module does not export',
    ).toEqual(['deadline-offset-unreadable']);
    expect(
      warmupDeadlineWiring(
        plantedDeadlineSource(`${FIXTURE_START_IDENTIFIER} + ${FIXTURE_START_IDENTIFIER}`),
      ).findings,
      'the adjacent must-fire: an offset that is a name but not an exported one, here the fixture start itself, is no line at all',
    ).toEqual(['deadline-offset-unreadable']);

    const deadlineCall = plantedDeadlineCall(COMPLIANT_DEADLINE);
    const outsideTheTry = replacedOnce(
      replacedOnce(plantedDeadlineSource(COMPLIANT_DEADLINE), `${deadlineCall}\n`, ''),
      PLANTED_USE_STATEMENT,
      `${deadlineCall.slice(2)}\n${PLANTED_USE_STATEMENT}`,
    );
    expect(
      warmupDeadlineWiring(outsideTheTry).findings,
      "a warmup awaited after the setup try refuses at the line into nothing that reaps the dev server, so its refusal never reaches the fixture's own catch",
    ).toEqual(['warmup-outside-setup-catch']);
    expect(
      warmupDeadlineWiring(
        replacedOnce(
          plantedDeadlineSource(COMPLIANT_DEADLINE),
          'workerServer: [',
          'otherServer: [',
        ),
      ).findings,
      'losing the fixture body must be reported, or a scan that found nothing to check reads as a compliant one',
    ).toEqual(['scope-missing']);
    expect(
      warmupDeadlineWiring(
        replacedOnce(
          plantedDeadlineSource(COMPLIANT_DEADLINE),
          deadlineCall,
          `${deadlineCall}\n${deadlineCall}`,
        ),
      ).findings,
    ).toEqual(['warmup-call-count']);
  });

  test("the fixture hands its warmup a deadline at its own starvation line, measured from the fixture's start, inside the try whose catch reaps", async () => {
    const budget = await declaredFirstLoadBudget();
    const wiring = warmupDeadlineWiring(fixtureSource());
    expect(
      wiring.findings,
      `the workerServer fixture body must pass ${WARMUP_FIRST_LOAD_EXPORT} a deadline of ${FIXTURE_START_IDENTIFIER} plus the starvation line its module exports, from inside the try whose catch reaps the dev server. The liveness tests prove the exported warmup ends a still-running first load at the deadline it is handed; that covers the fixture only if the deadline it hands over is its own line, and a first load that keeps progressing past it is otherwise ended by the registered ${budget.totalMs}ms slot, which never awaits the reap`,
    ).toEqual([]);

    expect(
      warmupDeadlineWiring(withoutLiveWarmupDeadline(fixtureSource())).findings,
      'the live-drift control: dropping the deadline from the shipped call must red, so the scan reads the fixture as it is spelled rather than only the planted copy',
    ).toContain('deadline-missing');

    const offsetMs = deadlineOffsetValue(wiring.offset, await fixtureExports());
    expect(
      offsetMs,
      `the deadline must sit exactly the ${budget.starvationLineMs}ms starvation line after the fixture starts, the last elapsed its own ${REFUSE_STARVED_BUDGET_SLOT_EXPORT} admits. It sits ${String(offsetMs)}ms after it`,
    ).toBe(budget.starvationLineMs);
  });
});
