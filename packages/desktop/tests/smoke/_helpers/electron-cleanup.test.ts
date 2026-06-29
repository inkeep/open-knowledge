/**
 * Real-subprocess narrow-integration test for `closeAppBounded` — the
 * primitive used by the `captureStderrFor` smoke fixture's teardown to
 * guarantee bounded reap of every Electron process group launched in a
 * smoke test.
 *
 * Why this is a NARROW INTEGRATION test, not a unit test: tests (a) and
 * (c) observe real `'exit'` events from a real Node `ChildProcess`
 * (the mock unit tier fires `'exit'` synthetically via EventEmitter,
 * which can't catch regressions in how the primitive consumes the real
 * event stream). Test (b)'s differentiation is real `proc.pid` flow
 * from `spawn` into the negated-PID kill argument — the spy
 * deliberately doesn't deliver the kill (the contract is "bounded fires
 * within budget" — OS-level signal-receipt is a separate concern). The
 * sibling unit test at `tests/unit/electron-cleanup-bounded.test.ts`
 * already pins call patterns against mocked ChildProcess + mocked kill
 * spies; this file complements that with real subprocess spawn + real
 * PID flow + real wall-clock measurement, so a regression in real-PID
 * arg construction or real-`'exit'`-event consumption is caught at the
 * OS layer that production smoke fixtures actually run against.
 *
 * Why this lives in `_helpers/` rather than `tests/unit/`: it's a sibling
 * of `electron-cleanup.ts` and `parse-timeouts.test.ts`, both of which
 * carry test infrastructure that the smoke harness depends on. Keeping
 * tests next to the helpers they exercise makes ownership obvious when a
 * future helper change requires updating the contract.
 *
 * Contract these tests protect: the primitive's interaction with the OS
 * — real-process `'exit'` event observation, real-PID kill argument
 * construction, real wall-clock budget enforcement. Real-signal-receipt
 * verification (i.e., asserting `proc.signalCode === 'SIGKILL'` after
 * delivery) is intentionally out of scope here — the afterEach reaper
 * handles real cleanup, and a real-delivery variant would race the
 * reaper without adding signal beyond the existing assertions.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { closeAppBounded } from './electron-cleanup';

const spawnedProcs: ChildProcess[] = [];

afterEach(() => {
  for (const proc of spawnedProcs) {
    if (
      proc.pid !== undefined &&
      !proc.killed &&
      proc.exitCode === null &&
      proc.signalCode === null
    ) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
    }
  }
  spawnedProcs.length = 0;
});

function spawnNode(body: string): ChildProcess {
  const proc = spawn('node', ['-e', body], {
    detached: true,
    stdio: 'ignore',
  });
  spawnedProcs.push(proc);
  return proc;
}

async function awaitSpawn(proc: ChildProcess): Promise<void> {
  if (proc.pid !== undefined) return;
  await new Promise<void>((resolve) => {
    proc.once('spawn', () => resolve());
  });
}

describe('closeAppBounded — real subprocess contract', () => {
  test('(a) graceful exit during gracefulMs wait → returns shortly after exit, no SIGKILL fired', async () => {
    const proc = spawnNode(`setTimeout(() => process.exit(0), 100);`);
    await awaitSpawn(proc);

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | string }> = [];
    const spyKill = (pid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid, signal });
    };

    const start = Date.now();
    await closeAppBounded(proc, { gracefulMs: 5_000, kill: spyKill });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1_500);
    expect(killCalls).toEqual([]);
    expect(proc.exitCode === 0 || proc.signalCode !== null).toBe(true);
  });

  test('(b) hung subprocess (traps + ignores SIGTERM) → returns within gracefulMs + slack, kill spy receives (-pid, SIGKILL)', async () => {
    const hangBody = `
      process.on('SIGTERM', () => { /* swallow */ });
      setInterval(() => {}, 1000);
    `;
    const proc = spawnNode(hangBody);
    await awaitSpawn(proc);
    const pid = proc.pid;
    if (pid === undefined) throw new Error('spawn did not assign pid');

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | string }> = [];
    const spyKill = (killPid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid: killPid, signal });
    };

    const start = Date.now();
    await closeAppBounded(proc, { gracefulMs: 300, kill: spyKill });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3_000);

    expect(killCalls.length).toBe(1);
    expect(killCalls[0]).toEqual({ pid: -pid, signal: 'SIGKILL' });
  });

  test('(c) already-exited subprocess → closeAppBounded returns ~immediately, no kill fired', async () => {
    const proc = spawnNode(`process.exit(0);`);
    await awaitSpawn(proc);
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      proc.once('exit', () => resolve());
    });
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | string }> = [];
    const spyKill = (pid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid, signal });
    };

    const start = Date.now();
    await closeAppBounded(proc, { gracefulMs: 5_000, kill: spyKill });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(killCalls).toEqual([]);
  });
});
