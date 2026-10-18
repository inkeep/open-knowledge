import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getMachineId,
  lockFilePath,
  type ProcessLockMetadata,
  resolveLockDir,
} from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import {
  installSignalBoundary,
  type SignalBoundary,
} from '../../../../test-support/held-signal-boundary.test-helper.ts';
import {
  legacyServerLock,
  lockWrittenBeforeProcessStarted,
  lockWrittenByRunningProcess,
  type OwnedProcess,
  ownedProcessHasExited,
  startOwnedProcess,
  stopOwnedProcess,
} from '../../../../test-support/owned-process.test-helper.ts';
import { runClean } from './clean.ts';
import { makeServerLockCheck } from './diagnose-health-checks/server-lock.ts';
import { inspectLock } from './lock-state.ts';
import { runPs } from './ps.ts';
import { runStatus } from './status.ts';
import { runStop } from './stop.ts';

const owned: OwnedProcess[] = [];
const roots: string[] = [];
let boundary: SignalBoundary | undefined;

afterEach(async () => {
  boundary?.restore();
  boundary = undefined;
  for (const holder of owned.splice(0)) await stopOwnedProcess(holder);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function seedServerLock(
  startedAt: (holder: OwnedProcess) => string,
  lockOverrides: Record<string, unknown> = {},
): Promise<{
  root: string;
  lockDir: string;
  lockPath: string;
  lock: ProcessLockMetadata;
  holder: OwnedProcess;
}> {
  const holder = await startOwnedProcess();
  owned.push(holder);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lock-pid-reuse-')));
  roots.push(root);
  const lockDir = join(root, '.ok', 'local');
  mkdirSync(lockDir, { recursive: true });
  const lockPath = lockFilePath(lockDir, 'server');
  const serialized = JSON.stringify({
    ...legacyServerLock({
      pid: holder.pid,
      startedAt: startedAt(holder),
      machineId: getMachineId(),
      worktreeRoot: root,
    }),
    ...lockOverrides,
  });
  writeFileSync(lockPath, serialized, { mode: 0o600 });
  return { root, lockDir, lockPath, lock: JSON.parse(serialized), holder };
}

async function psEntries(lockDir: string, holderPid: number): Promise<unknown> {
  const printed: string[] = [];
  await runPs({
    discover: async () => [lockDir],
    resolveCommand: (pid) => (pid === holderPid ? `owned-process ${pid}` : null),
    resolveUsage: (pid) => (pid === holderPid ? { cpuPercent: 1, memPercent: 2 } : null),
    json: true,
    log: (msg) => printed.push(msg),
  });
  return JSON.parse(printed.join('\n'));
}

function signalsSentTo(pid: number): Array<{ target: number; signal: unknown }> {
  if (boundary === undefined) throw new Error('no signal boundary installed');
  return [...boundary.delivered, ...boundary.refused].filter((record) => record.target === pid);
}

describe('a server lock whose pid now belongs to a process started after the lock was written', () => {
  test('inspectLock does not report the server alive', async () => {
    const { lockDir } = await seedServerLock(lockWrittenBeforeProcessStarted);

    expect(inspectLock(lockDir, 'server').status).not.toBe('alive');
  });

  test('ok status does not report the server alive', async () => {
    const { lockDir } = await seedServerLock(lockWrittenBeforeProcessStarted);

    const report = runStatus({ lockDir, log: () => {} });

    expect(report.server.state).not.toBe('alive');
    expect(report.server.alive).toBe(false);
  });

  test('ok clean prunes the lock', async () => {
    const { lockDir, lockPath, holder } = await seedServerLock(lockWrittenBeforeProcessStarted);

    const outcome = runClean({ lockDir, log: () => {}, error: () => {} });

    expect(outcome.failed).toEqual([]);
    expect(outcome.pruned.map((target) => target.lockPath)).toEqual([lockPath]);
    expect(existsSync(lockPath)).toBe(false);
    expect(ownedProcessHasExited(holder)).toBe(false);
  });

  test('ok stop signals nothing to the process now holding the pid', async () => {
    const { lockDir, holder } = await seedServerLock(lockWrittenBeforeProcessStarted);
    boundary = installSignalBoundary({ deliverToHeldChildren: false });

    const outcome = await runStop({
      lockDir,
      log: () => {},
      error: () => {},
      probeClients: async () => null,
    });

    expect(signalsSentTo(holder.pid).filter((record) => record.signal !== 0)).toEqual([]);
    expect(outcome.stopped).toEqual([]);
    expect(ownedProcessHasExited(holder)).toBe(false);
  });

  test('ok ps reports the lock stale and attributes no process to it', async () => {
    const { lockDir, lockPath, holder } = await seedServerLock(lockWrittenBeforeProcessStarted);

    expect(await psEntries(lockDir, holder.pid)).toEqual([
      expect.objectContaining({
        lockPath,
        displayStatus: 'stale',
        command: null,
        ui: null,
        server: expect.objectContaining({ usage: null }),
      }),
    ]);
  });

  test('ok diagnose warns about a stale lock and points at ok clean', async () => {
    const { root, lockDir } = await seedServerLock(lockWrittenBeforeProcessStarted);
    expect(resolveLockDir(root)).toBe(lockDir);

    const result = await makeServerLockCheck().run({ cwd: root });

    expect(result).toMatchObject({ name: 'server-lock', status: 'warn' });
    expect(result.remediation).toContain('ok clean');
  });

  test('ok stop signals nothing when the reading it was handed still showed the lock live', async () => {
    const { lockDir, lockPath, lock, holder } = await seedServerLock(
      lockWrittenBeforeProcessStarted,
    );
    boundary = installSignalBoundary({ deliverToHeldChildren: false });

    const outcome = await runStop({
      lockDir,
      inspect: () => ({ status: 'alive', lockPath, lock }),
      force: true,
      log: () => {},
      error: () => {},
    });

    expect(signalsSentTo(holder.pid).filter((record) => record.signal !== 0)).toEqual([]);
    expect(outcome.stopped).toEqual([]);
    expect(ownedProcessHasExited(holder)).toBe(false);
  });
});

describe('a server lock from another machine whose pid is a local process started after the lock was written', () => {
  test('ok stop signals nothing to that local process', async () => {
    const { lockDir, holder } = await seedServerLock(lockWrittenBeforeProcessStarted, {
      machineId: randomUUID(),
      hostname: 'another-machine.example',
    });
    boundary = installSignalBoundary({ deliverToHeldChildren: false });

    const outcome = await runStop({
      lockDir,
      log: () => {},
      error: () => {},
      probeClients: async () => null,
    });

    expect(signalsSentTo(holder.pid).filter((record) => record.signal !== 0)).toEqual([]);
    expect(outcome.stopped).toEqual([]);
    expect(ownedProcessHasExited(holder)).toBe(false);
  });
});

describe('a server lock held by the live process that wrote it', () => {
  test('inspectLock reports the server alive', async () => {
    const { lockDir, holder } = await seedServerLock(lockWrittenByRunningProcess);

    expect(inspectLock(lockDir, 'server')).toMatchObject({
      status: 'alive',
      lock: { pid: holder.pid },
    });
  });

  test('ok status reports the server alive', async () => {
    const { lockDir, holder } = await seedServerLock(lockWrittenByRunningProcess);

    const report = runStatus({ lockDir, log: () => {} });

    expect(report.server).toMatchObject({ state: 'alive', alive: true, pid: holder.pid });
  });

  test('ok clean leaves the lock in place', async () => {
    const { lockDir, lockPath } = await seedServerLock(lockWrittenByRunningProcess);

    const outcome = runClean({ lockDir, log: () => {}, error: () => {} });

    expect(outcome).toEqual({ pruned: [], failed: [] });
    expect(existsSync(lockPath)).toBe(true);
  });

  test('ok stop sends SIGTERM to the writer', async () => {
    const { lockDir, holder } = await seedServerLock(lockWrittenByRunningProcess);
    boundary = installSignalBoundary({ deliverToHeldChildren: true });
    boundary.hold(holder.child);

    const outcome = await runStop({
      lockDir,
      log: () => {},
      error: () => {},
      probeClients: async () => null,
    });

    expect(boundary.delivered).toContainEqual({ target: holder.pid, signal: 'SIGTERM' });
    expect(outcome.stopped).toEqual([expect.objectContaining({ pid: holder.pid })]);
  });

  test('ok ps reports the writer running', async () => {
    const { lockDir, lockPath, holder } = await seedServerLock(lockWrittenByRunningProcess);

    expect(await psEntries(lockDir, holder.pid)).toEqual([
      expect.objectContaining({
        lockPath,
        displayStatus: 'running',
        command: `owned-process ${holder.pid}`,
        server: expect.objectContaining({
          pid: holder.pid,
          usage: { cpuPercent: 1, memPercent: 2 },
        }),
      }),
    ]);
  });

  test('ok diagnose reports the lock held by the writer', async () => {
    const { root, lockDir, holder } = await seedServerLock(lockWrittenByRunningProcess);
    expect(resolveLockDir(root)).toBe(lockDir);

    const result = await makeServerLockCheck().run({ cwd: root });

    expect(result).toMatchObject({ name: 'server-lock', status: 'fail' });
    expect(result.summary).toContain(`pid ${holder.pid}`);
  });

  test('ok stop sends SIGTERM to the writer when handed a reading of its lock', async () => {
    const { lockDir, lockPath, lock, holder } = await seedServerLock(lockWrittenByRunningProcess);
    boundary = installSignalBoundary({ deliverToHeldChildren: true });
    boundary.hold(holder.child);

    const outcome = await runStop({
      lockDir,
      inspect: () => ({ status: 'alive', lockPath, lock }),
      force: true,
      log: () => {},
      error: () => {},
    });

    expect(boundary.delivered).toContainEqual({ target: holder.pid, signal: 'SIGTERM' });
    expect(outcome.stopped).toEqual([expect.objectContaining({ pid: holder.pid })]);
  });
});
