import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JSONReport, JSONReportSpec, JSONReportSuite } from '@playwright/test/reporter';
import { createNestedPlaywrightEnv } from './nested-playwright-env.test-helper.ts';

const APP_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SUBTREE_ROOT = fileURLToPath(new URL('../../../../../..', import.meta.url));
const RUN_CONFIG = fileURLToPath(new URL('./ownership-run.config.ts', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./occupy-selected-port.cjs', import.meta.url));
const JANITOR = fileURLToPath(new URL('./owner-scratch-janitor.cjs', import.meta.url));
const LEASE_PROBE = fileURLToPath(new URL('./lease-inheritance-probe.cjs', import.meta.url));
const PLAYWRIGHT_CLI = createRequire(join(APP_ROOT, 'package.json')).resolve(
  '@playwright/test/cli',
);
const RUNNER_STDIO = ['ignore', 'pipe', 'pipe'] as const;
const LEASE_PROBE_STDIO = [...RUNNER_STDIO, 'ipc'] as const;

type ProcessExit = [code: number | null, signal: NodeJS.Signals | null];

export interface LeaseRoute {
  label: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stdioLength?: number;
  stdout?: string;
  message?: string;
  error?: string;
}

export interface LeaseInheritanceRun {
  labels: string[];
  routes: LeaseRoute[] | undefined;
  driverExit: ProcessExit;
  readerExit: ProcessExit;
  transcript: string;
}

export interface OwnershipCase {
  file: string;
  name: string;
  caller: string;
  runDir?: string;
}

export interface OwnedEndpointRelease {
  releaseResponse: string | undefined;
  releaseError: string | undefined;
}

export interface OwnershipRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdioClosed: boolean;
  transcript: string;
  events: unknown[];
  eventFilePresent: boolean;
  report: JSONReport | undefined;
  matchingSpecs: JSONReportSpec[];
  errors: JSONReport['errors'] | undefined;
  lifetime:
    | (OwnedEndpointRelease & {
        receipt: { port: number; nonce: string; pid: number };
        servingAfterExit: boolean;
        selfBoundFired: boolean;
      })
    | undefined;
}

export interface OwnershipCaseResult {
  run: OwnershipRun;
  scratchReleased: Promise<Error | undefined>;
}

async function openOwnerControl(): Promise<{ port: number; close: () => Promise<void> }> {
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owner control has no TCP address');
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    close: () => {
      if (closing) return closing;
      closing = new Promise<void>((resolve) => {
        for (const socket of clients) socket.end();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}

async function startScratchJanitor(runDir: string) {
  const janitor = spawn(process.execPath, [JANITOR, runDir, realpathSync(tmpdir())], {
    stdio: ['pipe', 'ignore', 'inherit', 'ipc'],
  });
  const completed = new Promise<Error | undefined>((resolve) => {
    janitor.once('error', resolve);
    janitor.once('exit', (code, signal) => {
      resolve(
        code === 0
          ? undefined
          : new Error(`owner scratch cleanup failed: code=${code} signal=${signal}`),
      );
    });
  });
  const lease = janitor.stdin;
  if (!lease) {
    const error = await completed;
    throw error ?? new Error('owner scratch janitor has no lease pipe');
  }
  try {
    const [message] = await Promise.race([
      once(janitor, 'message'),
      completed.then((error) => {
        throw error ?? new Error('owner scratch janitor exited before readiness');
      }),
    ]);
    if (message !== 'ready') throw new Error('invalid owner scratch janitor readiness');
  } catch (error) {
    lease.destroy();
    await completed;
    throw error;
  }
  return { lease, completed };
}

function specsOf(suites: JSONReportSuite[]): JSONReportSpec[] {
  return suites.flatMap((suite) => [...suite.specs, ...specsOf(suite.suites ?? [])]);
}

function causeCode(error: unknown): unknown {
  if (!(error instanceof Error)) return undefined;
  const { cause } = error;
  return typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
}

function isRefusedConnection(error: unknown): boolean {
  return error instanceof TypeError && causeCode(error) === 'ECONNREFUSED';
}

function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = causeCode(error);
  const summary = `${error.name}: ${error.message}`;
  return code === undefined ? summary : `${summary} (${String(code)})`;
}

export async function probeOwnedEndpoint(receipt: {
  port: number;
  nonce: string;
}): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${receipt.port}/identity`, {
      signal: AbortSignal.timeout(1_000),
    });
    return (await response.text()) === receipt.nonce;
  } catch (error) {
    return !isRefusedConnection(error);
  }
}

export async function releaseIfServing(
  receipt: { port: number; nonce: string },
  serving: boolean,
): Promise<OwnedEndpointRelease> {
  if (!serving) return { releaseResponse: undefined, releaseError: undefined };
  try {
    const response = await fetch(`http://127.0.0.1:${receipt.port}/release/${receipt.nonce}`, {
      signal: AbortSignal.timeout(1_000),
    });
    return { releaseResponse: await response.text(), releaseError: undefined };
  } catch (error) {
    return { releaseResponse: undefined, releaseError: describeFailure(error) };
  }
}

export function readOwnershipRecords(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

export async function runOwnershipCase(ownershipCase: OwnershipCase): Promise<OwnershipCaseResult> {
  const runDir = ownershipCase.runDir ?? mkdtempSync(join(tmpdir(), 'ok-port-ownership-'));
  const runtimeTmp = join(runDir, 'tmp');
  mkdirSync(runtimeTmp);
  const ownerControl = await openOwnerControl().catch((error: unknown) => {
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  });
  const janitor = await startScratchJanitor(runDir).catch(async (error: unknown) => {
    await ownerControl.close();
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  });
  const env = createNestedPlaywrightEnv({
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${PRELOAD}`.trim(),
    OK_PORT_OWNERSHIP_CALLER: ownershipCase.caller,
    OK_PORT_OWNERSHIP_RECORDS: join(runDir, 'events.jsonl'),
    OK_PORT_OWNERSHIP_RUN_DIR: runDir,
    OK_PORT_OWNERSHIP_LEASE_FD: String(RUNNER_STDIO.length),
    OK_PORT_OWNERSHIP_CONTROL_PORT: String(ownerControl.port),
    ...(ownershipCase.caller === 'global-warm-cache.ts'
      ? { OK_TEST_VITE_SEED_DIR: join(runDir, 'seed') }
      : {}),
    TMPDIR: runtimeTmp,
    TURBO_CACHE_DIR: join(SUBTREE_ROOT, '.turbo', 'cache'),
    PLAYWRIGHT_HTML_OPEN: 'never',
  });

  try {
    const child = spawn(
      process.execPath,
      [
        PLAYWRIGHT_CLI,
        'test',
        '--config',
        RUN_CONFIG,
        ownershipCase.file,
        '--grep',
        ownershipCase.name,
        '--workers=2',
        '--retries=0',
      ],
      { cwd: APP_ROOT, env, stdio: [...RUNNER_STDIO, janitor.lease] as const },
    );
    const { stdout, stderr } = child;
    if (!stdout || !stderr) throw new Error('nested ownership runner has no output pipes');
    let transcript = '';
    stdout.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    stderr.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const closed = new Promise<true>((resolve) => {
      child.once('close', () => resolve(true));
    });
    const { exitCode, signal } = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, exitSignal) => {
        void ownerControl
          .close()
          .then(() => resolve({ exitCode: code, signal: exitSignal }), reject);
      });
    });
    let closeBound: ReturnType<typeof setTimeout> | undefined;
    const stdioClosed = await Promise.race([
      closed,
      new Promise<false>((resolve) => {
        closeBound = setTimeout(() => resolve(false), 5_000);
      }),
    ]).finally(() => clearTimeout(closeBound));
    if (!stdioClosed) {
      stdout.destroy();
      stderr.destroy();
    }
    const report = existsSync(join(runDir, 'results.json'))
      ? (JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) as JSONReport)
      : undefined;
    const eventsPath = join(runDir, 'events.jsonl');
    const eventFilePresent = existsSync(eventsPath);
    const events = eventFilePresent ? readOwnershipRecords(eventsPath) : [];
    let lifetime: OwnershipRun['lifetime'];
    if (ownershipCase.caller.startsWith('lifetime-')) {
      const receiptPath = join(runDir, 'lifetime-receipt.json');
      if (existsSync(receiptPath)) {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
          port: number;
          nonce: string;
          pid: number;
        };
        const servingAfterExit = await probeOwnedEndpoint(receipt);
        const release = await releaseIfServing(receipt, servingAfterExit);
        lifetime = {
          receipt,
          servingAfterExit,
          selfBoundFired: existsSync(join(runDir, 'lifetime-self-bound')),
          ...release,
        };
      }
    }
    return {
      run: {
        exitCode,
        signal,
        stdioClosed,
        transcript,
        events,
        eventFilePresent,
        report,
        matchingSpecs: specsOf(report?.suites ?? []).filter(
          (spec) => spec.title === ownershipCase.name,
        ),
        errors: report?.errors,
        lifetime,
      },
      scratchReleased: janitor.completed,
    };
  } finally {
    await ownerControl.close();
    janitor.lease.destroy();
  }
}

export async function runLeaseInheritanceProbe(): Promise<LeaseInheritanceRun> {
  const reader = spawn(process.execPath, [LEASE_PROBE, 'reader'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const readerClosed = once(reader, 'close') as Promise<ProcessExit>;
  let received = '';
  let transcript = '';
  reader.stdout.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });
  reader.stderr.on('data', (chunk: Buffer) => {
    transcript += chunk.toString('utf8');
  });
  const lease = reader.stdin;
  const driver = spawn(process.execPath, [LEASE_PROBE, 'driver'], {
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${PRELOAD}`.trim(),
      OK_PORT_OWNERSHIP_LEASE_FD: String(LEASE_PROBE_STDIO.length),
    },
    stdio: [...LEASE_PROBE_STDIO, lease] as const,
  });
  for (const stream of [driver.stdout, driver.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
  }
  const driverClosed = once(driver, 'close') as Promise<ProcessExit>;
  const ready = await Promise.race([
    once(driver, 'message').then(([message]) => message as { routes: LeaseRoute[] }),
    driverClosed.then(() => undefined),
  ]);
  const released = once(lease, 'close');
  lease.destroy();
  await released;
  if (ready && driver.connected) driver.send('write');
  return {
    routes: ready?.routes,
    driverExit: await driverClosed,
    readerExit: await readerClosed,
    labels: received.split('\n').filter(Boolean),
    transcript,
  };
}
