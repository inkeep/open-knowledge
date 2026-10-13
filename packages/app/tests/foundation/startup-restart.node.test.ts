import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type {
  LeaseOutcome,
  LeaseRequest,
  WorkerServerEnv,
} from '../stress/_helpers/reuse/lease-protocol.ts';
import { WorkerServerSupervisor } from '../stress/_helpers/reuse/server-supervisor.ts';
import {
  CONTRACT_SERVER_CONFIG,
  contractServerGeneration,
  contractServerLauncher,
  restartContractServer,
} from './contract-dev-server.test-helper.ts';
import { CONTRACT_SERVER_EXCLUSIVE_RESOURCE_ENV } from './fixtures/contract-dev-server-routes.ts';

const RESTART_SETTLE_MS = 10_000;

interface Rig {
  readonly supervisor: WorkerServerSupervisor;
  readonly launcher: ReturnType<typeof contractServerLauncher>;
  readonly okRoot: string;
  request(run: string): LeaseRequest;
}

interface ImportingConfig {
  readonly configFile: string;
  readonly importedModule: string;
  edit(value: string): void;
}

const openRigs: Rig[] = [];
const openDirs: string[] = [];

function importingConfig(): ImportingConfig {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-restart-config-')));
  openDirs.push(dir);
  const importedModule = join(dir, 'imported-input.ts');
  const configFile = join(dir, 'vite.config.mts');
  const edit = (value: string) => {
    writeFileSync(importedModule, `export const importedInput = ${JSON.stringify(value)};\n`);
  };
  edit('v1');
  writeFileSync(
    configFile,
    [
      `import contract from ${JSON.stringify(CONTRACT_SERVER_CONFIG)};`,
      "import { importedInput } from './imported-input.ts';",
      'export default { ...contract, define: { __IMPORTED_INPUT__: JSON.stringify(importedInput) } };',
      '',
    ].join('\n'),
  );
  return { configFile, importedModule, edit };
}

function makeRig({
  configFile,
  workerServerEnv = {},
}: {
  readonly configFile?: string;
  readonly workerServerEnv?: WorkerServerEnv;
} = {}): Rig {
  const okRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-restart-root-')));
  mkdirSync(join(okRoot, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(okRoot, 'packages', 'app', 'src', 'App.tsx'), 'export const app = 1;\n');
  const launcher = contractServerLauncher({ configFile });
  const rig: Rig = {
    supervisor: new WorkerServerSupervisor({
      okRoot,
      launch: launcher.launch,
      identityTimeoutMs: 2_000,
    }),
    launcher,
    okRoot,
    request: (run) => ({
      worktree: okRoot,
      config: '/worktree/packages/app/playwright.config.ts#chromium',
      run,
      slot: 0,
      workerServerEnv,
      serverMode: 'dev',
    }),
  };
  openRigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of openRigs.splice(0)) {
    await rig.supervisor.shutdown();
    rmSync(rig.okRoot, { recursive: true, force: true });
  }
  for (const dir of openDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function granted(outcome: LeaseOutcome): Extract<LeaseOutcome, { kind: 'granted' }> {
  if (outcome.kind !== 'granted') {
    throw new Error(`expected a granted lease, got ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('a dev server that restarts in-process on its own port keeps its startup receipt, and the next run reuses it', async () => {
  const rig = makeRig();
  const first = granted(await rig.supervisor.acquire(rig.request('run-a')));
  await rig.supervisor.release(first.token, false);
  const [server] = rig.launcher.launched;
  if (server === undefined) throw new Error('the supervisor launched no server');

  await restartContractServer(server);
  await expect
    .poll(() => contractServerGeneration(server).catch(() => 0), { timeout: RESTART_SETTLE_MS })
    .toBe(2);

  const second = granted(await rig.supervisor.acquire(rig.request('run-b')));
  expect(second).toMatchObject({ launched: false, baseURL: first.baseURL, port: first.port });
  expect(rig.launcher.launched).toHaveLength(1);
  expect(rig.launcher.stderrOf(server)).not.toContain('automatic Vite startup');
});

test('a dev server that restarts in-process onto another port exits naming the endpoint change, and the next run starts a new one', async () => {
  const rig = makeRig();
  const first = granted(await rig.supervisor.acquire(rig.request('run-a')));
  await rig.supervisor.release(first.token, false);
  const [server] = rig.launcher.launched;
  if (server === undefined) throw new Error('the supervisor launched no server');
  const exited = new Promise<number | null>((resolve) => {
    server.proc.once('exit', (code) => resolve(code));
  });

  await restartContractServer(server, await freePort());

  expect(await exited).toBe(1);
  expect(rig.launcher.stderrOf(server)).toContain(
    `automatic Vite startup restarted in-process and bound {"nonce":"${server.identity.nonce}"`,
  );
  const second = granted(await rig.supervisor.acquire(rig.request('run-b')));
  expect(second).toMatchObject({
    launched: true,
    relaunchedBecause: 'its server process exited with code 1',
  });
});

test('a slot whose in-process restart failed after an edit to a module its configuration imports is relaunched, naming that module', async () => {
  const config = importingConfig();
  const rig = makeRig({
    configFile: config.configFile,
    workerServerEnv: { [CONTRACT_SERVER_EXCLUSIVE_RESOURCE_ENV]: '1' },
  });
  const first = granted(await rig.supervisor.acquire(rig.request('run-a')));
  await rig.supervisor.release(first.token, false);
  const [server] = rig.launcher.launched;
  if (server === undefined) throw new Error('the supervisor launched no server');

  config.edit('v2');
  await restartContractServer(server);
  await expect
    .poll(() => rig.launcher.stderrOf(server), { timeout: RESTART_SETTLE_MS })
    .toContain('server restart failed');
  expect(await contractServerGeneration(server)).toBe(1);

  const second = granted(await rig.supervisor.acquire(rig.request('run-b')));
  expect(second).toMatchObject({
    launched: true,
    relaunchedBecause: `its loaded configuration inputs changed: ${config.importedModule}`,
  });
});

test('a slot whose env file changed after its server loaded its configuration is relaunched, naming that file', async () => {
  const rig = makeRig();
  const first = granted(await rig.supervisor.acquire(rig.request('run-a')));
  await rig.supervisor.release(first.token, false);
  const [server] = rig.launcher.launched;
  if (server === undefined) throw new Error('the supervisor launched no server');

  const envFile = join(server.contentDir, '.env.local');
  writeFileSync(envFile, 'VITE_CONTRACT_INPUT=edited\n');

  const second = granted(await rig.supervisor.acquire(rig.request('run-b')));
  expect(second).toMatchObject({
    launched: true,
    relaunchedBecause: `its loaded configuration inputs changed: ${envFile}`,
  });
});

test('a slot that restarted in-process after an edit to a module its configuration imports serves what it reloaded, and the next run reuses it', async () => {
  const config = importingConfig();
  const rig = makeRig({ configFile: config.configFile });
  const first = granted(await rig.supervisor.acquire(rig.request('run-a')));
  await rig.supervisor.release(first.token, false);
  const [server] = rig.launcher.launched;
  if (server === undefined) throw new Error('the supervisor launched no server');

  config.edit('v2');
  await restartContractServer(server);
  await expect
    .poll(() => contractServerGeneration(server).catch(() => 0), { timeout: RESTART_SETTLE_MS })
    .toBe(2);

  const second = granted(await rig.supervisor.acquire(rig.request('run-b')));
  expect(second).toMatchObject({ launched: false, baseURL: first.baseURL, port: first.port });
  expect(rig.launcher.launched).toHaveLength(1);
});
