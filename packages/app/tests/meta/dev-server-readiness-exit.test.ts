import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { getFreePort, waitForHttpReady } from '../stress/_helpers/server-process.ts';

const NEVER_READY_BUDGET_MS = 1_500;
const EXIT_DETECTION_BUDGET_MS = 10_000;

const spawned: ChildProcess[] = [];

function spawnNode(source: string): ChildProcess {
  const proc = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
  spawned.push(proc);
  return proc;
}

async function unboundBaseURL(): Promise<string> {
  return `http://127.0.0.1:${await getFreePort()}`;
}

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
});

describe('waitForHttpReady', () => {
  test('names the exit code when the dev command dies before the server binds', async () => {
    const baseURL = await unboundBaseURL();
    const proc = spawnNode('process.exit(7)');

    const started = Date.now();
    await expect(waitForHttpReady(baseURL, 60_000, proc)).rejects.toThrow(
      /exited with code 7 after \d+ms without becoming ready/,
    );
    expect(Date.now() - started).toBeLessThan(EXIT_DETECTION_BUDGET_MS);
  });

  test('names the signal when the dev command is killed before the server binds', async () => {
    const baseURL = await unboundBaseURL();
    const proc = spawnNode('setTimeout(() => {}, 60_000)');
    await new Promise((resolve) => setTimeout(resolve, 100));
    proc.kill('SIGKILL');

    const started = Date.now();
    await expect(waitForHttpReady(baseURL, 60_000, proc)).rejects.toThrow(
      /exited on SIGKILL after \d+ms without becoming ready/,
    );
    expect(Date.now() - started).toBeLessThan(EXIT_DETECTION_BUDGET_MS);
  });

  test('still reports a readiness timeout while the dev command is alive', async () => {
    const baseURL = await unboundBaseURL();
    const proc = spawnNode('setTimeout(() => {}, 60_000)');

    await expect(waitForHttpReady(baseURL, NEVER_READY_BUDGET_MS, proc)).rejects.toThrow(
      `did not become ready within ${NEVER_READY_BUDGET_MS}ms`,
    );
  });
});
