import { type ChildProcess, execFileSync, type SpawnSyncReturns, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive, lockFilePath } from '@inkeep/open-knowledge-server';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as cliLogger from '../cli-logger.ts';
import { runRemoval } from './removal-plan.ts';
import { readRemovalProcessStart } from './removal-process-start.ts';
import { stopServerForRemoval } from './stop-for-removal.ts';

describe('stopServerForRemoval', () => {
  let dir: string;
  const children: ChildProcess[] = [];
  let warnings: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-removal-stop-'));
    warnings = [];
    vi.spyOn(cliLogger, 'getCliLogger').mockReturnValue(
      pino({ level: 'warn' }, { write: (record) => warnings.push(JSON.parse(record)) }),
    );
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function expectRefusalLogged(status: string, detail: string): void {
    expect(warnings).toEqual([
      expect.objectContaining({
        level: 40,
        lockDir: dir,
        lockPath: lockFilePath(dir, 'server'),
        status,
        msg: expect.stringContaining(detail),
      }),
    ]);
  }

  async function startServer(source: string): Promise<number> {
    const child = spawn(process.execPath, ['-e', source], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(child);
    await once(child, 'message');
    const pid = child.pid;
    if (pid === undefined) throw new Error('Server fixture did not start');
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({ pid, hostname: hostname(), port: 0, startedAt: new Date().toISOString() }),
    );
    return pid;
  }

  test('reports no server when no lock exists', async () => {
    expect(await stopServerForRemoval(dir)).toEqual({ stopped: 0, failed: [] });
  });

  test('rejects an unreadable lock instead of claiming shutdown was verified', async () => {
    writeFileSync(lockFilePath(dir, 'server'), '{bad metadata');
    await expect(stopServerForRemoval(dir)).rejects.toThrow(
      `Once you have confirmed they have exited, remove the stale lock file at ${lockFilePath(dir, 'server')} and retry cleanup`,
    );
    expectRefusalLogged('corrupt', 'unreadable server lock');
  });

  test('does not signal an unrelated process whose PID appears in an older lock', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({ pid, hostname: hostname(), port: 0, startedAt: '2000-01-01T00:00:00.000Z' }),
    );
    const probe: {
      elapsedMs?: number;
      code?: string | null;
      status?: number | null;
      signal?: NodeJS.Signals | null;
      output?: string;
    } = {};
    const removal = stopServerForRemoval(dir, {
      readProcessStart: (processId) =>
        readRemovalProcessStart(processId, {
          run: (command, args, options) => {
            const startedAt = performance.now();
            try {
              const output = execFileSync(command, args, options);
              probe.output = output.trim().slice(0, 80);
              return output;
            } catch (error) {
              const failure = error as NodeJS.ErrnoException &
                Pick<SpawnSyncReturns<string>, 'status' | 'signal'>;
              probe.code = failure.code ?? null;
              probe.status = failure.status ?? null;
              probe.signal = failure.signal ?? null;
              throw error;
            } finally {
              probe.elapsedMs = Math.round(performance.now() - startedAt);
            }
          },
        }),
    });
    await expect(removal, `OS process-start query: ${JSON.stringify(probe)}`).rejects.toThrow(
      'started after the server lock',
    );
    expect(isProcessAlive(pid)).toBe(true);
    expectRefusalLogged('alive', 'started after the server lock');
  });

  test('does not signal a process when its lock has no acquisition timestamp', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({ pid, hostname: hostname(), port: 0 }),
    );
    await expect(stopServerForRemoval(dir)).rejects.toThrow('valid start time');
    expect(isProcessAlive(pid)).toBe(true);
    expectRefusalLogged('alive', 'valid start time');
  });

  test('does not signal when the process start probe is unavailable and explains recovery', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    await expect(stopServerForRemoval(dir, { readProcessStart: () => null })).rejects.toThrow(
      'Confirm the OpenKnowledge server has exited before retrying cleanup',
    );
    expect(isProcessAlive(pid)).toBe(true);
    expectRefusalLogged('alive', 'Cannot verify the identity');
    if (process.platform === 'linux') {
      expect(warnings[0]?.msg).toContain('ps supporting -p and -o lstart=');
    }
  });

  test('requires a liveness recheck to accept an exited process after an unavailable identity probe', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const isAlive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await stopServerForRemoval(dir, { readProcessStart: () => null, isAlive })).toEqual({
      stopped: 0,
      failed: [],
    });
    expect(isAlive).toHaveBeenCalledTimes(2);
    expect(isProcessAlive(pid)).toBe(true);
  });

  test('allows a process older than its lock even when start times have only second precision', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const startedAt = readRemovalProcessStart(pid);
    if (startedAt === null) throw new Error('Could not read fixture process start time');
    const startSecond = Math.floor(startedAt / 1000) * 1000;
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({
        pid,
        hostname: hostname(),
        port: 0,
        startedAt: new Date(startSecond + 999).toISOString(),
      }),
    );
    expect(await stopServerForRemoval(dir, { readProcessStart: () => startSecond })).toEqual({
      stopped: 1,
      failed: [],
    });
    expect(isProcessAlive(pid)).toBe(false);
  });

  test('does not signal a local process named by a foreign-host lock', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({ pid, hostname: `${hostname()}-other-machine`, port: 0 }),
    );
    await expect(stopServerForRemoval(dir)).rejects.toThrow(
      'Confirm that no OpenKnowledge server is using this directory on the owning machine or any other machine sharing it',
    );
    expect(isProcessAlive(pid)).toBe(true);
    expectRefusalLogged('foreign-host', 'another machine');
    expect(warnings[0]?.msg).toContain(lockFilePath(dir, 'server'));
  });

  test.skipIf(process.platform === 'win32')('waits for the server to flush and exit', async () => {
    const flushed = join(dir, 'flushed');
    const pid = await startServer(`
      const fs = require('node:fs');
      process.on('SIGTERM', () => setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(flushed)}, 'saved');
        process.exit(0);
      }, 120));
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const outcome = await stopServerForRemoval(dir, { timeoutMs: 2000, pollIntervalMs: 10 });
    expect(outcome).toEqual({ stopped: 1, failed: [] });
    expect(readFileSync(flushed, 'utf8')).toBe('saved');
    expect(isProcessAlive(pid)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'fails without escalating when the server ignores SIGTERM',
    async () => {
      const pid = await startServer(`
      process.on('SIGTERM', () => {});
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
      const statePath = join(dir, 'state');
      writeFileSync(statePath, 'must survive');
      const outcome = await runRemoval(
        {
          scope: 'deinit',
          ops: [
            { kind: 'stop-server', group: 'project', label: 'Stop server', lockDir: dir },
            { kind: 'remove-path', group: 'project', label: 'Remove state', path: statePath },
          ],
        },
        {
          stopServer: (lockDir) =>
            stopServerForRemoval(lockDir, { timeoutMs: 100, pollIntervalMs: 10 }),
        },
      );
      expect(outcome.failed).toEqual([
        expect.objectContaining({
          op: expect.objectContaining({ kind: 'stop-server' }),
          detail: expect.stringContaining('still running'),
        }),
        expect.objectContaining({ op: expect.objectContaining({ kind: 'remove-path' }) }),
      ]);
      expect(isProcessAlive(pid)).toBe(true);
      expect(existsSync(statePath)).toBe(true);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'accepts a stale lock after the process is gone',
    async () => {
      const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
      const child = children.at(-1);
      if (!child) throw new Error('Server fixture missing');
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      expect(isProcessAlive(pid)).toBe(false);
      expect(await stopServerForRemoval(dir)).toEqual({ stopped: 0, failed: [] });
    },
  );
});
