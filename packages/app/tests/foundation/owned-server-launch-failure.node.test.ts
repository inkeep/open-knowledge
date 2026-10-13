import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Browser, WorkerInfo } from '@playwright/test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { E2E_SERVING_ENV } from '../stress/_helpers/prebuilt/prebuilt-serving.ts';
import { leaseWorkerServer, type ServerLease } from '../stress/_helpers/reuse/lease-fixture.ts';
import { REUSE_RUN_ENV, REUSE_SOCKET_ENV } from '../stress/_helpers/reuse/lease-protocol.ts';
import { launchOwnedWorkerServer } from '../stress/_helpers/reuse/owned-dev-server.ts';
import { WorkerServerSupervisor } from '../stress/_helpers/reuse/server-supervisor.ts';
import {
  type SupervisorEndpoint,
  serveSupervisor,
} from '../stress/_helpers/reuse/supervisor-socket.ts';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/seed-key.ts';
import { contractServerLauncher } from './contract-dev-server.test-helper.ts';

const faults = vi.hoisted(() => ({
  removal: new Set<string>(),
  open: new Set<string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const faulted = (prefixes: ReadonlySet<string>, target: unknown) =>
    [...prefixes].some((prefix) => basename(String(target)).startsWith(prefix));
  const errnoError = (code: string, description: string, syscall: string, target: unknown) =>
    Object.assign(new Error(`${code}: ${description}, ${syscall} '${String(target)}'`), {
      code,
      syscall,
      path: String(target),
    });
  return {
    ...fs,
    rmSync: (
      target: Parameters<typeof fs.rmSync>[0],
      options?: Parameters<typeof fs.rmSync>[1],
    ) => {
      if (faulted(faults.removal, target)) {
        throw errnoError('EACCES', 'permission denied', 'rmdir', target);
      }
      fs.rmSync(target, options);
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (faulted(faults.open, args[0])) {
        throw errnoError('ENOSPC', 'no space left on device', 'open', args[0]);
      }
      return fs.openSync(...args);
    },
  };
});

const WORKTREE = realpathSync(join(APP_PACKAGE_ROOT, '..', '..'));
const ENV_NAMES = ['TMPDIR', REUSE_SOCKET_ENV, REUSE_RUN_ENV, E2E_SERVING_ENV] as const;
const LABEL = 'launch-failure-s0';

const WORKER_INFO = {
  parallelIndex: 0,
  workerIndex: 0,
  config: { configFile: '/worktree/packages/app/playwright.config.ts' },
  project: { name: 'chromium' },
} as WorkerInfo;

const BROWSER_THE_REFUSED_LEASE_NEVER_OPENS = {} as Browser;

const savedEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
const openEndpoints: SupervisorEndpoint[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  faults.removal.clear();
  faults.open.clear();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const endpoint of openEndpoints.splice(0)) await endpoint.close();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Scratch {
  readonly tmp: string;
  readonly missingBuild: string;
  readonly socketPath: string;
}

function scratchWithOwnTmpdir(): Scratch {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-owned-launch-scratch-')));
  scratchDirs.push(root);
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  process.env.TMPDIR = tmp;
  return {
    tmp,
    missingBuild: join(root, 'no-prebuilt-build'),
    socketPath: join(root, 'supervisor.sock'),
  };
}

function viteCacheDirsOf(label: string): string[] {
  return readdirSync(join(APP_PACKAGE_ROOT, 'node_modules')).filter((name) =>
    name.startsWith(`.vite-${label}-`),
  );
}

describe('an owned server whose launch fails', () => {
  test('a worker whose owned server fails to start, and whose cleanup then fails too, is told both failures and the dev server log tail', async () => {
    const scratch = scratchWithOwnTmpdir();
    faults.removal.add(`ok-${LABEL}-`);
    const supervisor = new WorkerServerSupervisor({
      okRoot: WORKTREE,
      launch: (_slot, workerServerEnv) =>
        launchOwnedWorkerServer({
          label: LABEL,
          workerServerEnv,
          serving: { kind: 'prebuilt', outputDir: scratch.missingBuild },
        }),
      identityTimeoutMs: 2_000,
    });
    const endpoint = await serveSupervisor(supervisor, scratch.socketPath);
    openEndpoints.push(endpoint);
    process.env[REUSE_SOCKET_ENV] = scratch.socketPath;
    process.env[REUSE_RUN_ENV] = 'run-a';
    delete process.env[E2E_SERVING_ENV];
    const offered: Array<ServerLease | undefined> = [];

    await leaseWorkerServer(
      { workerServerEnv: {}, browser: BROWSER_THE_REFUSED_LEASE_NEVER_OPENS },
      async (lease) => {
        offered.push(lease);
      },
      WORKER_INFO,
    );

    const leftBehind = readdirSync(scratch.tmp);
    expect(leftBehind).toEqual([expect.stringMatching(new RegExp(`^ok-${LABEL}-`))]);
    const contentDir = join(scratch.tmp, leftBehind[0] ?? '');
    expect(viteCacheDirsOf(LABEL)).toEqual([]);
    expect(offered).toEqual([
      {
        kind: 'fresh',
        note: `slot 0 was refused (launch-failed: slot 0 could not start an owned server: the prebuilt DEV app at ${scratch.missingBuild} has no build manifest, so it is not served\n--- dev server log tail ---\n\n--- cleanup after this failure did not complete: EACCES: permission denied, rmdir '${contentDir}' ---), so this worker starts its own server`,
      },
    ]);
    expect(existsSync(contentDir)).toBe(true);
  }, 60_000);

  test('a launch whose server log cannot be opened releases its startup request and receipt directory, and says no log was open', async () => {
    const scratch = scratchWithOwnTmpdir();
    faults.open.add(`ok-e2e-${LABEL}-`);

    const failure = await launchOwnedWorkerServer({
      label: LABEL,
      workerServerEnv: {},
      serving: { kind: 'dev-server' },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(readdirSync(scratch.tmp)).toEqual([]);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      new RegExp(
        `^ENOSPC: no space left on device, open '${scratch.tmp}/ok-e2e-${LABEL}-\\d+-[a-z0-9]+\\.log'\\n--- no dev server log was open when this failure ended the launch ---$`,
      ),
    );
  });

  test('a contract dev server that exits before it is ready, and whose cleanup then fails too, reports its exit, its stderr and the cleanup failure', async () => {
    const scratch = scratchWithOwnTmpdir();
    faults.removal.add('ok-contract-s0-');
    const launcher = contractServerLauncher();

    const failure = await launcher
      .launch(0, { NODE_OPTIONS: `--require=${scratch.missingBuild}/preload.cjs` })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    const leftBehind = readdirSync(scratch.tmp);
    expect(leftBehind).toEqual([expect.stringMatching(/^ok-contract-s0-/)]);
    const contentDir = join(scratch.tmp, leftBehind[0] ?? '');
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(
      /^the contract dev server did not start: Error: automatic Vite startup command exited with code 1 without a receipt\n/,
    );
    expect(message).toContain(`Cannot find module '${scratch.missingBuild}/preload.cjs'`);
    expect(message).toMatch(
      new RegExp(
        `\\n--- cleanup after this failure did not complete: EACCES: permission denied, rmdir '${contentDir}' ---$`,
      ),
    );
    expect(launcher.launched).toEqual([]);
  });
});
