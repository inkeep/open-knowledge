import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
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
        `        await warmupAppFirstLoad(browser, started.baseURL, setupOverhead);
        reportBudgetOverrun(setupOverhead, workerInfo.workerIndex, residue);`,
        '        await warmupAppFirstLoad(browser, started.baseURL, setupOverhead);',
      ),
    );
    expect(
      withoutPostWarmupReport.reportBudgetOverrun,
      'dropping the post-warmup checkpoint must move the count, or the browser-context legs accumulate into the phase and are discarded unreported on every slot that is not starved',
    ).toBe(2);

    const withoutContextCloseWrap = budgetEnforcementCounts(
      mutatedFixtureSource(
        'await spendOnBudgetPhase(overhead, () => context.close());',
        'await context.close();',
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
const WARMUP_GOTO_SITE = 'warmupAppFirstLoad -> page.goto navigation bound';
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
]);

type BudgetScope = { kind: 'function'; name: string } | { kind: 'worker-server-fixture-body' };

type BudgetArgument = { kind: 'positional'; index: number } | { kind: 'option'; name: string };

type BudgetRequirement =
  | { kind: 'derived-readiness' }
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
    requires: { kind: 'derived-readiness' },
  },
  {
    site: WARMUP_GOTO_SITE,
    scope: { kind: 'function', name: 'warmupAppFirstLoad' },
    callee: 'goto',
    calls: 1,
    argument: { kind: 'option', name: 'timeout' },
    requires: { kind: 'reserve', key: WARMUP_GOTO_RESERVE_KEY },
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
      if (BUDGET_EXPORT_NAMES.has(callee)) budgetRoots.add(callee);
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
    if (spec.requires.kind === 'derived-readiness') {
      if (!use.budgetRoots.includes(RESOLVE_READINESS_EXPORT)) {
        findings.push({ site: spec.site, line, reason: 'unlinked', text: excerptOf(argument) });
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
  "const REQUIRED_FIXTURE_ENTRY_NAMES = ['test-doc.md'];",
].join('\n');

const COMPLIANT_READINESS_ARGUMENT = 'DERIVED_READINESS_MS';
const COMPLIANT_GOTO_ARGUMENT = `${DECLARED_RESERVES_EXPORT}.${WARMUP_GOTO_RESERVE_KEY}`;
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
  gotoArgument?: string;
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
  const goto = overrides.gotoArgument ?? COMPLIANT_GOTO_ARGUMENT;
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
    `  await page.goto(\`\${baseURL}/\`, { timeout: ${goto} });`,
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

  test('the warmup legs spend the reserves the manifest declares for them', () => {
    const source = fixtureSource();
    const findings = scanBudgetWiring(source);
    const resolved = resolvedBudgetCalls(source);

    expect(
      resolved.filter((call) => call.site === WARMUP_GOTO_SITE).length,
      'the warmup navigation call was not found, so nothing about its bound was checked',
    ).toBe(1);
    expect(
      resolved.filter((call) => call.site === WARMUP_VISIBLE_SITE).length,
      'the warmup visibility wait was not found, so nothing about its bound was checked',
    ).toBe(1);

    expect(
      findingsAt(findings, WARMUP_GOTO_SITE),
      `the warmup navigation must spend ${DECLARED_RESERVES_EXPORT}.${WARMUP_GOTO_RESERVE_KEY}. Playwright supplies its own default when the option is dropped, so the reserve table would silently over-state what the fixture spends`,
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
        WARMUP_GOTO_SITE,
        WARMUP_VISIBLE_SITE,
      ].sort(),
    );

    for (const spec of BUDGET_WIRING_SITES) {
      if (spec.requires.kind !== 'reserve') continue;
      expect(
        table[spec.requires.key],
        `${spec.site} spends the reserve ${spec.requires.key}, which the live ${DECLARED_RESERVES_EXPORT} does not declare`,
      ).toBeGreaterThan(0);
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
      plantedFixtureSource({ gotoArgument: COMPLIANT_VISIBLE_ARGUMENT }),
    );
    expect(reasonsOf(swappedReserve)).toEqual(['wrong-reserve']);
    expect(swappedReserve[0]?.site).toBe(WARMUP_GOTO_SITE);

    const droppedGotoOption = scanBudgetWiring(
      plantedFixtureSource({}).replace(`, { timeout: ${COMPLIANT_GOTO_ARGUMENT} }`, ''),
    );
    expect(reasonsOf(droppedGotoOption)).toEqual(['argument-missing']);

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
            gotoArgument: `RESERVE_ALIAS.${WARMUP_GOTO_RESERVE_KEY}`,
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
});
