import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getLocalDir,
  getMachineId,
  isProcessAlive,
  readServerLock,
} from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import {
  legacyServerLock,
  lockWrittenBeforeProcessStarted,
  lockWrittenByRunningProcess,
  type OwnedProcess,
  startOwnedProcess,
  stopOwnedProcess,
} from '../../../../test-support/owned-process.test-helper.ts';
import { WindowManager, type WindowManagerDeps } from '../../src/main/window-manager.ts';

interface SignalRecord {
  pid: number;
  signal: number | NodeJS.Signals;
}

const owned: OwnedProcess[] = [];
const projects: string[] = [];

afterEach(async () => {
  for (const holder of owned.splice(0)) await stopOwnedProcess(holder);
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

async function seedProject(
  startedAt: (holder: OwnedProcess) => string,
): Promise<{ projectPath: string; holder: OwnedProcess }> {
  const holder = await startOwnedProcess();
  owned.push(holder);
  const projectPath = realpathSync(mkdtempSync(join(tmpdir(), 'ok-desktop-lock-pid-reuse-')));
  projects.push(projectPath);
  const lockDir = getLocalDir(projectPath);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, 'server.lock'),
    JSON.stringify(
      legacyServerLock({
        pid: holder.pid,
        startedAt: startedAt(holder),
        machineId: getMachineId(),
        worktreeRoot: projectPath,
      }),
    ),
    { mode: 0o600 },
  );
  return { projectPath, holder };
}

function windowManagerWithLockReaders(signals: SignalRecord[]): WindowManager {
  const deps: WindowManagerDeps = {
    createWindow: () => {
      throw new Error('no project window is opened in this test');
    },
    forkUtility: () => {
      throw new Error('no utility process is started in this test');
    },
    utilityEntryPath: '/fake/utility-entry.js',
    rendererEntryPath: '/fake/renderer/index.html',
    terminalAuthAvailable: true,
    appVersion: '9.9.9-test',
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    killProbe: (pid, signal) => {
      signals.push({ pid, signal });
    },
    showGate: { register: () => () => {}, fireThemeApplied: () => {} },
    readServerLock: (lockDir) => readServerLock(lockDir),
    isProcessAlive: (pid) => isProcessAlive(pid),
    sigtermGraceMs: 0,
  };
  return new WindowManager(deps);
}

function signalsTo(signals: SignalRecord[], pid: number): SignalRecord[] {
  return signals.filter((record) => record.pid === pid && record.signal !== 0);
}

describe('desktop server termination when the lock pid now belongs to a process started after the lock was written', () => {
  test('Stop Server & Retry signals nothing to that process', async () => {
    const { projectPath, holder } = await seedProject(lockWrittenBeforeProcessStarted);
    const signals: SignalRecord[] = [];

    await windowManagerWithLockReaders(signals).forceStopConflictingServer(projectPath);

    expect(signalsTo(signals, holder.pid)).toEqual([]);
  });

  test('restarting the attached server signals nothing to that process', async () => {
    const { projectPath, holder } = await seedProject(lockWrittenBeforeProcessStarted);
    const signals: SignalRecord[] = [];

    await windowManagerWithLockReaders(signals).restartAttachedServer(projectPath);

    expect(signalsTo(signals, holder.pid)).toEqual([]);
  });
});

describe('desktop server termination when the lock is held by the live process that wrote it', () => {
  test('Stop Server & Retry sends SIGTERM to the writer', async () => {
    const { projectPath, holder } = await seedProject(lockWrittenByRunningProcess);
    const signals: SignalRecord[] = [];

    await windowManagerWithLockReaders(signals).forceStopConflictingServer(projectPath);

    expect(signalsTo(signals, holder.pid)[0]).toEqual({ pid: holder.pid, signal: 'SIGTERM' });
  });

  test('restarting the attached server sends SIGTERM to the writer', async () => {
    const { projectPath, holder } = await seedProject(lockWrittenByRunningProcess);
    const signals: SignalRecord[] = [];

    await windowManagerWithLockReaders(signals).restartAttachedServer(projectPath);

    expect(signalsTo(signals, holder.pid)[0]).toEqual({ pid: holder.pid, signal: 'SIGTERM' });
  });
});
