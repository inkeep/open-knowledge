import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export interface OwnerLossRun extends OwnedEndpointRelease {
  driverPid: number | undefined;
  driverExit: number | null;
  driverSignal: NodeJS.Signals | null;
  receipt: Receipt;
  witnessClosed: boolean;
  scratchGone: boolean;
  events: unknown[];
  servingAfterOwnerExit: boolean;
  transcript: string;
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

export async function runOwnerLossControl(): Promise<OwnerLossRun> {
  const runDir = mkdtempSync(join(tmpdir(), 'ok-port-ownership-'));
  const child = spawn(process.execPath, ['--import', 'tsx', DRIVER, runDir], {
    cwd: APP_ROOT,
    env: process.env,
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

  try {
    const receipt = await awaitReceipt(runDir, child);
    const witness = connect(receipt.port, '127.0.0.1');
    await once(witness, 'connect');
    scratchWatcher = watchScratchGone(runDir);
    const closed = once(witness, 'close');
    const exited = once(child, 'exit');
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
      transcript,
    };
  } finally {
    scratchWatcher?.stop();
    if (child.exitCode === null && child.signalCode === null && child.connected) {
      const exited = once(child, 'exit');
      child.send('exit');
      await exited.catch(() => {});
    }
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  }
}
