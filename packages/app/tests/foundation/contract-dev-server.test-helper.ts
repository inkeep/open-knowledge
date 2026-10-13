import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TEST_SERVER_HOST_FAMILY } from '../../src/build/test-server-startup-contract.ts';
import type { LaunchOwnedServer, OwnedServer } from '../stress/_helpers/reuse/server-supervisor.ts';
import {
  APP_PACKAGE_ROOT,
  beginViteStartup,
  createViteStartupRequest,
  killGracefully,
  waitForBoundViteEndpoint,
} from '../stress/_helpers/server-process.ts';
import { removeAllDuringTeardown } from '../stress/_helpers/teardown-fs.ts';
import {
  CONTRACT_SERVER_EXIT_PATH,
  CONTRACT_SERVER_FAIL_READINESS_PATH,
  CONTRACT_SERVER_FORGE_PATH,
  CONTRACT_SERVER_GENERATION_PATH,
  CONTRACT_SERVER_RESTART_PATH,
  type ContractServerReadinessCheck,
} from './fixtures/contract-dev-server-routes.ts';

const VITE_CLI = join(
  dirname(createRequire(join(APP_PACKAGE_ROOT, 'package.json')).resolve('vite/package.json')),
  'bin',
  'vite.js',
);
export const CONTRACT_SERVER_CONFIG = join(
  import.meta.dirname,
  'fixtures',
  'contract-dev-server.ts',
);
const CONTRACT_SERVER_READY_MS = 15_000;

export interface ContractServerLauncher {
  readonly launch: LaunchOwnedServer;
  readonly launched: OwnedServer[];
  readonly environments: Array<Readonly<Record<string, string>>>;
  stderrOf(server: OwnedServer): string;
}

export function contractServerLauncher({
  configFile = CONTRACT_SERVER_CONFIG,
}: {
  readonly configFile?: string;
} = {}): ContractServerLauncher {
  const launched: OwnedServer[] = [];
  const environments: Array<Readonly<Record<string, string>>> = [];
  const stderrs = new WeakMap<OwnedServer, () => string>();
  const launch: LaunchOwnedServer = async (slot, workerServerEnv) => {
    environments.push(workerServerEnv);
    const request = createViteStartupRequest('127.0.0.1');
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), `ok-contract-s${slot}-`)));
    let stderr = '';
    const proc = spawn(
      process.execPath,
      [VITE_CLI, '--config', configFile, '--host', request.host],
      {
        cwd: contentDir,
        detached: true,
        env: { ...process.env, ...workerServerEnv, ...request.environment },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    let releasing: Promise<void> | undefined;
    const release = () => {
      releasing ??= killGracefully(proc).finally(() =>
        removeAllDuringTeardown(contentDir, request.receiptDir),
      );
      return releasing;
    };
    try {
      const endpoint = await waitForBoundViteEndpoint(
        beginViteStartup(request, proc),
        CONTRACT_SERVER_READY_MS,
      );
      const server: OwnedServer = {
        proc,
        identity: {
          nonce: request.nonce,
          address: request.host,
          family: TEST_SERVER_HOST_FAMILY[request.host],
          port: endpoint.port,
        },
        baseURL: endpoint.baseURL,
        contentDir,
        release,
      };
      launched.push(server);
      stderrs.set(server, () => stderr);
      return server;
    } catch (error) {
      let cleanupFailure = '';
      try {
        await release();
      } catch (cleanupError) {
        cleanupFailure = `\n--- cleanup after this failure did not complete: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)} ---`;
      }
      throw new Error(
        `the contract dev server did not start: ${String(error)}\n${stderr}${cleanupFailure}`,
      );
    }
  };
  const stderrOf = (server: OwnedServer): string => {
    const read = stderrs.get(server);
    if (read === undefined) throw new Error(`${server.baseURL} was not launched by this launcher`);
    return read();
  };
  return { launch, launched, environments, stderrOf };
}

async function control(server: OwnedServer, path: string): Promise<void> {
  const response = await fetch(`${server.baseURL}${path}`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned status ${response.status}: ${body}`);
}

export async function exitContractServer(server: OwnedServer): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (server.proc.exitCode !== null || server.proc.signalCode !== null) resolve();
    else server.proc.once('exit', () => resolve());
  });
  await control(server, CONTRACT_SERVER_EXIT_PATH);
  await exited;
}

export function forgeContractServerIdentity(server: OwnedServer): Promise<void> {
  return control(server, CONTRACT_SERVER_FORGE_PATH);
}

export function failContractServerReadiness(
  server: OwnedServer,
  check: ContractServerReadinessCheck,
): Promise<void> {
  return control(server, `${CONTRACT_SERVER_FAIL_READINESS_PATH}/${check}`);
}

export function restartContractServer(server: OwnedServer, port?: number): Promise<void> {
  return control(
    server,
    port === undefined
      ? CONTRACT_SERVER_RESTART_PATH
      : `${CONTRACT_SERVER_RESTART_PATH}?port=${port}`,
  );
}

export async function contractServerGeneration(server: OwnedServer): Promise<number> {
  const response = await fetch(`${server.baseURL}${CONTRACT_SERVER_GENERATION_PATH}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`${CONTRACT_SERVER_GENERATION_PATH} returned status ${response.status}`);
  }
  return Number(await response.text());
}
