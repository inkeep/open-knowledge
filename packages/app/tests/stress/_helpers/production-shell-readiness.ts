import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { TEST_SERVER_HOST_FAMILY } from '../../../src/build/test-server-startup-contract.ts';
import {
  type BoundViteEndpoint,
  describeExit,
  endpointBaseURL,
  requireBoundMs,
  type ViteStartupRequest,
} from './server-process.ts';

const LOCK_POLL_INTERVAL_MS = 100;

export interface ProductionShellStartup {
  readonly host: ViteStartupRequest['host'];
  readonly port: number;
  readonly contentDir: string;
  readonly proc: ChildProcess;
  readonly commandPid: () => number | undefined;
  readonly startedAt: number;
}

type LockVerdict =
  | { readonly kind: 'bound' }
  | { readonly kind: 'pending'; readonly reason: string }
  | { readonly kind: 'foreign'; readonly reason: string }
  | { readonly kind: 'stopping'; readonly reason: string };

export function productionShellLockPath(contentDir: string): string {
  return join(contentDir, '.ok', 'local', 'server.lock');
}

function readLock(path: string): Record<string, unknown> | string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `no server lock at ${path}`;
    throw err;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  return `the server lock at ${path} is not a JSON object yet`;
}

function lockVerdict(startup: ProductionShellStartup): LockVerdict {
  const path = productionShellLockPath(startup.contentDir);
  const lock = readLock(path);
  if (typeof lock === 'string') return { kind: 'pending', reason: lock };
  const pid = startup.commandPid();
  if (pid === undefined) {
    return { kind: 'pending', reason: 'the worker has not learned its command pid yet' };
  }
  if (lock.pid !== pid) {
    return {
      kind: 'foreign',
      reason: `the server lock at ${path} names pid ${String(lock.pid)}, not the pid ${pid} this worker spawned`,
    };
  }
  if (lock.draining === true) {
    return { kind: 'stopping', reason: `the server lock at ${path} is draining` };
  }
  if (lock.port !== startup.port) {
    return {
      kind: 'pending',
      reason: `the server lock at ${path} names port ${String(lock.port)}, not the requested ${startup.port}`,
    };
  }
  return { kind: 'bound' };
}

function commandExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function endpointOf(startup: ProductionShellStartup): BoundViteEndpoint {
  return {
    port: startup.port,
    baseURL: endpointBaseURL({
      address: startup.host,
      family: TEST_SERVER_HOST_FAMILY[startup.host],
      port: startup.port,
    }),
  };
}

export async function waitForProductionShellEndpoint(
  startup: ProductionShellStartup,
  timeoutMs: number,
): Promise<BoundViteEndpoint> {
  requireBoundMs(timeoutMs, 'waitForProductionShellEndpoint');
  const deadlineAt = startup.startedAt + timeoutMs;
  while (true) {
    const verdict = lockVerdict(startup);
    if (verdict.kind === 'bound') return endpointOf(startup);
    if (verdict.kind === 'foreign') {
      throw new Error(
        `production-shell server for ${startup.host}:${startup.port} is not the one this worker spawned: ${verdict.reason}`,
      );
    }
    if (verdict.kind === 'stopping') {
      throw new Error(
        `production-shell server command is shutting down before it served ${startup.host}:${startup.port}: ${verdict.reason}`,
      );
    }
    if (commandExited(startup.proc)) {
      throw new Error(
        `production-shell server command exited ${describeExit(startup.proc)} before its server lock in ${startup.contentDir} named port ${startup.port}: ${verdict.reason}`,
      );
    }
    if (Date.now() >= deadlineAt) {
      throw new Error(
        `production-shell server did not bind ${startup.host}:${startup.port} within ${timeoutMs}ms: ${verdict.reason}`,
      );
    }
    await wait(Math.min(LOCK_POLL_INTERVAL_MS, Math.max(0, deadlineAt - Date.now())));
  }
}

export function assertProductionShellIdentity(startup: ProductionShellStartup): void {
  if (commandExited(startup.proc)) {
    throw new Error(
      `production-shell server command exited ${describeExit(startup.proc)} after its readiness checks`,
    );
  }
  const verdict = lockVerdict(startup);
  if (verdict.kind !== 'bound') {
    throw new Error(
      `production-shell server for ${startup.host}:${startup.port} no longer holds the endpoint this worker spawned it on: ${verdict.reason}`,
    );
  }
}

export async function waitForProductionShellReady(
  startup: ProductionShellStartup,
  timeoutMs: number,
  probe: (endpoint: BoundViteEndpoint) => Promise<void>,
): Promise<BoundViteEndpoint> {
  const endpoint = await waitForProductionShellEndpoint(startup, timeoutMs);
  await probe(endpoint);
  assertProductionShellIdentity(startup);
  return endpoint;
}
