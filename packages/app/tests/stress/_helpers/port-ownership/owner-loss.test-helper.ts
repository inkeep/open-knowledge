import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCleanupOrder } from './cleanup-order.test-helper.ts';
import {
  type OwnedEndpointRelease,
  probeOwnedEndpoint,
  readOwnershipRecords,
  releaseIfServing,
} from './run-case.test-helper.ts';

const DRIVER = fileURLToPath(new URL('./owner-loss-driver.ts', import.meta.url));
const APP_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

interface Receipt {
  port: number;
  nonce: string;
  pid: number;
}

interface OrderingEvent {
  phase: string;
  pid: number;
}

export interface OwnerLossRun extends OwnedEndpointRelease {
  driverPid: number | undefined;
  driverExit: number | null;
  driverSignal: NodeJS.Signals | null;
  receipt: Receipt;
  witnessClosed: boolean;
  scratchGone: boolean;
  events: unknown[];
  servingAfterOwnerExit: boolean;
  ordering: { native: boolean; order: string[]; events: OrderingEvent[] };
  transcript: string;
}

const UNORDERED_PHASES = new Set(['runner', 'server', 'exit', 'yield', 'ack:yield']);

function cleanupOrderFrom(events: OrderingEvent[], serverPid: number): string[] {
  const roles = new Map<number, string>();
  for (const { phase, pid } of events) {
    if (phase === 'runner' || phase === 'server') roles.set(pid, phase);
  }
  let started = false;
  return events.flatMap(({ phase, pid }) => {
    if (phase === 'server' && pid === serverPid) started = true;
    if (!started || UNORDERED_PHASES.has(phase)) return [];
    return [`${roles.get(pid) ?? 'unregistered'}:${phase}`];
  });
}

async function awaitReceipt(runDir: string, child: ChildProcess): Promise<Receipt> {
  const receiptPath = join(runDir, 'lifetime-receipt.json');
  return new Promise<Receipt>((resolve, reject) => {
    const watcher = watch(runDir, check);
    let settled = false;
    function settle(result: Receipt | Error): void {
      if (settled) return;
      settled = true;
      watcher.close();
      child.off('exit', onExit);
      child.off('error', onError);
      watcher.off('error', onError);
      if (result instanceof Error) reject(result);
      else resolve(result);
    }
    function check(): void {
      if (!existsSync(receiptPath)) return;
      let receipt: Receipt;
      try {
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      settle(receipt);
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      settle(new Error(`owner exited before lifetime receipt: code=${code} signal=${signal}`));
    }
    function onError(error: Error): void {
      settle(error);
    }
    child.once('exit', onExit);
    child.once('error', onError);
    watcher.once('error', onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    } else {
      check();
    }
  });
}

function watchScratchGone(runDir: string): { result: Promise<boolean>; stop: () => void } {
  let finishResult: (gone: boolean) => void = () => {};
  const result = new Promise<boolean>((resolve) => {
    finishResult = resolve;
  });
  let watcher: ReturnType<typeof watch> | undefined;
  let bound: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  function finish(gone: boolean): void {
    if (settled) return;
    settled = true;
    watcher?.close();
    clearTimeout(bound);
    finishResult(gone);
  }
  if (!existsSync(runDir)) {
    finish(true);
  } else {
    bound = setTimeout(() => finish(false), 30_000);
    try {
      watcher = watch(runDir, () => {
        if (!existsSync(runDir)) finish(true);
      });
      watcher.once('error', () => finish(!existsSync(runDir)));
    } catch {
      finish(!existsSync(runDir));
    }
    if (!existsSync(runDir)) finish(true);
  }
  return { result, stop: () => finish(false) };
}

export async function runOwnerLossControl(outputDir: string): Promise<OwnerLossRun> {
  const ordering = await createCleanupOrder(outputDir);
  const runDir = mkdtempSync(join(tmpdir(), 'ok-port-ownership-'));
  const child = spawn(process.execPath, ['--import', 'tsx', DRIVER, runDir], {
    cwd: APP_ROOT,
    env: { ...ordering.env, OK_PORT_OWNERSHIP_SCHEDULE_RUN_DIR: runDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] as const,
  });
  let transcript = '';
  let scratchWatcher: ReturnType<typeof watchScratchGone> | undefined;
  child.stdout?.on('data', (chunk: Buffer) => {
    transcript += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    transcript += chunk.toString('utf8');
  });

  let failure: unknown;
  try {
    const receipt = await awaitReceipt(runDir, child);
    const witness = connect(receipt.port, '127.0.0.1');
    await once(witness, 'connect');
    scratchWatcher = watchScratchGone(runDir);
    const closed = once(witness, 'close');
    const exited = once(child, 'exit');
    if (ordering.nativeOrdering) {
      await Promise.race([
        ordering.beforeOwnerExit(receipt.pid),
        exited.then(() => {
          throw new Error('owner exited before cleanup ordering was ready');
        }),
      ]);
    }
    child.send('exit');
    const [driverExit, driverSignal] = (await exited) as [number | null, NodeJS.Signals | null];
    let closeBound: ReturnType<typeof setTimeout> | undefined;
    const witnessClosed = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        closeBound = setTimeout(() => resolve(false), 10_000);
      }),
    ]).finally(() => clearTimeout(closeBound));
    if (!witnessClosed) witness.destroy();
    const scratchGone = await scratchWatcher.result;
    const orderingEvents = [...ordering.events];
    const eventsPath = join(runDir, 'events.jsonl');
    const events = existsSync(eventsPath) ? readOwnershipRecords(eventsPath) : [];
    const servingAfterOwnerExit = await probeOwnedEndpoint(receipt);
    const release = await releaseIfServing(receipt, servingAfterOwnerExit);
    return {
      driverPid: child.pid,
      driverExit,
      driverSignal,
      receipt,
      witnessClosed,
      scratchGone,
      events,
      servingAfterOwnerExit,
      ...release,
      ordering: {
        native: ordering.nativeOrdering,
        order: cleanupOrderFrom(orderingEvents, receipt.pid),
        events: orderingEvents,
      },
      transcript,
    };
  } catch (error) {
    failure = error;
  } finally {
    scratchWatcher?.stop();
    if (child.exitCode === null && child.signalCode === null && child.connected) {
      const exited = once(child, 'exit');
      child.send('exit');
      await exited.catch(() => {});
    }
    await ordering.close();
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  throw new Error(`${message}\n--- owner-loss driver output\n${transcript}`, { cause: failure });
}
