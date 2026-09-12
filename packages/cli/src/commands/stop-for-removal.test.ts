import { type ChildProcess, execFileSync, type SpawnSyncReturns, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive, lockFilePath, scanLockProcesses } from '@inkeep/open-knowledge-server';
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

  test('recovers a dead PID-only lock for deinit', async () => {
    writeFileSync(lockFilePath(dir, 'server'), JSON.stringify({ pid: 4242 }));
    expect(await stopServerForRemoval(dir, { isAlive: () => false })).toMatchObject({
      stopped: 0,
      failed: [],
      skipped: expect.stringContaining('has exited'),
    });
  });

  test('refuses a live PID-only lock without inventing an owning machine', async () => {
    writeFileSync(lockFilePath(dir, 'server'), JSON.stringify({ pid: 4242 }));
    await expect(stopServerForRemoval(dir, { isAlive: () => true })).rejects.toThrow(
      'does not record its owning machine',
    );
    expect(warnings[0]).toMatchObject({ status: 'unverified-owner', lockPid: 4242 });
  });

  test('reports no server when no lock exists', async () => {
    expect(await stopServerForRemoval(dir)).toEqual({ stopped: 0, failed: [] });
  });

  test('skips malformed filesystem residue without claiming a server was stopped', async () => {
    writeFileSync(lockFilePath(dir, 'server'), '{bad metadata');
    const scanProcesses = vi.fn(async () => ({ candidates: [], unavailable: [] }));
    expect(await stopServerForRemoval(dir, { scanProcesses })).toMatchObject({
      stopped: 0,
      failed: [],
      skipped: expect.stringContaining('malformed'),
    });
    expect(scanProcesses).toHaveBeenCalledOnce();
    expect(readFileSync(lockFilePath(dir, 'server'), 'utf8')).toBe('{bad metadata');
  });

  test.each([0, 1, -1, 1.5, 2147483648, '123', null])(
    'skips invalid PID %j without a liveness probe or signal',
    async (pid) => {
      writeFileSync(lockFilePath(dir, 'server'), JSON.stringify({ pid, hostname: hostname() }));
      const isAlive = vi.fn(() => {
        throw new Error('invalid PID must not be probed');
      });
      const result = await stopServerForRemoval(dir, {
        isAlive,
        scanProcesses: async () => ({ candidates: [], unavailable: [] }),
      });
      expect(result).toMatchObject({
        stopped: 0,
        failed: [],
        skipped: expect.stringContaining('malformed'),
      });
      expect(isAlive).not.toHaveBeenCalled();
    },
  );

  test('preserves malformed locks when process inspection is unavailable', async () => {
    writeFileSync(lockFilePath(dir, 'server'), 'not json');
    await expect(
      stopServerForRemoval(dir, {
        scanProcesses: async () => ({ candidates: [], unavailable: ['ps unavailable'] }),
      }),
    ).rejects.toThrow('ps unavailable');
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'preserves a lock after a genuine access failure',
    async () => {
      const path = lockFilePath(dir, 'server');
      writeFileSync(path, 'not json');
      chmodSync(path, 0o000);
      try {
        await expect(stopServerForRemoval(dir)).rejects.toThrow(
          'Restore file and parent-directory access',
        );
        expectRefusalLogged('read-error', 'EACCES');
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  test('preserves a non-file lock path', async () => {
    mkdirSync(lockFilePath(dir, 'server'));
    await expect(stopServerForRemoval(dir)).rejects.toThrow('Cannot read the server lock');
  });

  test.each([undefined, 0, 1, '123'])(
    'retains foreign ownership with unusable PID %j for deinit and global-only removal',
    async (pid) => {
      const raw = JSON.stringify({ pid, machineId: 'not-this-machine' });
      writeFileSync(lockFilePath(dir, 'server'), raw);
      const isAlive = vi.fn(() => {
        throw new Error('invalid PID must not be probed');
      });
      const scanProcesses = vi.fn(async () => ({ candidates: [], unavailable: [] }));
      await expect(stopServerForRemoval(dir, { isAlive, scanProcesses })).rejects.toThrow(
        'another machine',
      );
      expect(scanProcesses).not.toHaveBeenCalled();
      expect(
        await stopServerForRemoval(dir, {
          isAlive,
          scanProcesses,
          preserveProjectState: true,
        }),
      ).toMatchObject({
        stopped: 0,
        failed: [],
        skipped: expect.stringContaining('foreign-owned'),
      });
      expect(isAlive).not.toHaveBeenCalled();
      expect(readFileSync(lockFilePath(dir, 'server'), 'utf8')).toBe(raw);
    },
  );

  test('preserves valid foreign ownership even when the PID is absent on this machine', async () => {
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({ pid: 99999999, hostname: 'remote-host' }),
    );
    await expect(stopServerForRemoval(dir, { isAlive: () => false })).rejects.toThrow(
      'owning machine',
    );
  });

  test('retains a foreign project while allowing local-only cleanup after process inspection', async () => {
    const raw = JSON.stringify({ pid: 99999999, hostname: 'remote-host' });
    writeFileSync(lockFilePath(dir, 'server'), raw);
    const scanProcesses = vi.fn(async () => ({ candidates: [], unavailable: [] }));
    expect(
      await stopServerForRemoval(dir, { preserveProjectState: true, scanProcesses }),
    ).toMatchObject({
      stopped: 0,
      failed: [],
      skipped: expect.stringContaining('foreign-owned'),
    });
    expect(scanProcesses).toHaveBeenCalledOnce();
    expect(readFileSync(lockFilePath(dir, 'server'), 'utf8')).toBe(raw);
  });

  test('cannot skip a foreign project when local process inspection is unavailable', async () => {
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({ pid: 99999999, hostname: 'remote-host' }),
    );
    await expect(
      stopServerForRemoval(dir, {
        preserveProjectState: true,
        scanProcesses: async () => ({ candidates: [], unavailable: ['ps unavailable'] }),
      }),
    ).rejects.toThrow('ps unavailable');
  });

  test.skipIf(process.platform === 'win32')(
    'blocks a malformed lock associated with a live marked process',
    async () => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.send('ready'); setInterval(() => {}, 1000)",
          '--',
          `--ok-lock-dir-b64=${Buffer.from(dir).toString('base64url')}`,
        ],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      children.push(child);
      await once(child, 'message');
      writeFileSync(lockFilePath(dir, 'server'), 'not json');
      const scan = await scanLockProcesses();
      expect(scan.candidates).toContainEqual({
        lockDir: realpathSync(dir),
        pid: child.pid,
        source: 'lock-dir-argument',
      });
      await expect(stopServerForRemoval(dir, { scanProcesses: async () => scan })).rejects.toThrow(
        'live process candidates',
      );
      if (child.pid === undefined) throw new Error('Missing child PID');
      expect(isProcessAlive(child.pid)).toBe(true);
    },
  );

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

  test.each([
    ['linux', 'ps supporting -p and -o lstart='],
    ['darwin', 'Stop the server manually.'],
  ] as const)(
    'explains the %s probe recovery when the process start probe is unavailable',
    async (platform, expected) => {
      const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
      await expect(
        stopServerForRemoval(dir, { platform, readProcessStart: () => null }),
      ).rejects.toThrow('Confirm the OpenKnowledge server has exited before retrying cleanup');
      expect(isProcessAlive(pid)).toBe(true);
      expectRefusalLogged('alive', 'Cannot verify the identity');
      expect(warnings[0]).toMatchObject({ lockPid: pid });
      expect(warnings[0]?.msg).toContain(expected);
    },
  );

  test('records the native identity failure cause in the CLI log, never in the refusal a user reads', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    await expect(
      stopServerForRemoval(dir, {
        readProcessStart: (_pid, options) => {
          options?.onNativeFailure?.({
            kind: 'query-failed',
            reason: 'readProcessStart failed: OpenProcess: os error 5',
          });
          return null;
        },
      }),
    ).rejects.toThrow('Cannot verify the identity');
    expect(isProcessAlive(pid)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      nativeFailures: [
        { kind: 'query-failed', reason: 'readProcessStart failed: OpenProcess: os error 5' },
      ],
    });
    expect(warnings[0]?.msg).toContain(lockFilePath(dir, 'server'));
    expect(warnings[0]?.msg).not.toContain('OpenProcess: os error 5');
    expect(warnings[0]?.msg).toContain('recorded in the CLI log under ~/.ok/logs');
  });

  test.each([
    [
      'unavailable',
      'Reinstall OpenKnowledge to restore the Windows component that verifies process identity',
      'the operating system refused the query',
    ],
    [
      'query-failed',
      'the operating system refused the query, so reinstalling will not help',
      'Reinstall OpenKnowledge',
    ],
  ] as const)(
    'picks the win32 remedy for a %s fault on any host',
    async (kind, expected, absent) => {
      const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
      await expect(
        stopServerForRemoval(dir, {
          platform: 'win32',
          readProcessStart: (_pid, options) => {
            options?.onNativeFailure?.({ kind, reason: 'probe detail' });
            return null;
          },
        }),
      ).rejects.toThrow(expected);
      expect(isProcessAlive(pid)).toBe(true);
      expect(warnings[0]?.msg).not.toContain(absent);
    },
  );

  test('names no remedy on win32 when nothing was reported', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    await expect(
      stopServerForRemoval(dir, { platform: 'win32', readProcessStart: () => null }),
    ).rejects.toThrow('Stop the server manually.');
    expect(isProcessAlive(pid)).toBe(true);
    expect(warnings[0]?.msg).not.toContain('Reinstall OpenKnowledge');
    expect(warnings[0]?.msg).not.toContain('refused the query');
  });

  test('does not prescribe a reinstall when the component loaded and the OS refused the query', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    await expect(
      stopServerForRemoval(dir, {
        readProcessStart: (_pid, options) => {
          options?.onNativeFailure?.({
            kind: 'query-failed',
            reason: 'readProcessStart failed: OpenProcess: os error 5',
          });
          return null;
        },
      }),
    ).rejects.toThrow('Cannot verify the identity');
    expect(isProcessAlive(pid)).toBe(true);
    expect(warnings[0]).toMatchObject({
      nativeFailures: [{ kind: 'query-failed' }],
    });
  });

  test('never repeats upstream install advice to a user removing the product', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const napiAdvisory =
      'bundled loader failed to load: \\\\?\\C:\\app\\dist\\native\\native-config.win32-x64-msvc.node is not a valid Win32 application. -> Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.';
    const error = await stopServerForRemoval(dir, {
      readProcessStart: (_pid, options) => {
        options?.onNativeFailure?.({ kind: 'unavailable', reason: napiAdvisory });
        return null;
      },
    }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(isProcessAlive(pid)).toBe(true);
    expect(error?.message).toContain('Cannot verify the identity');
    for (const upstreamOnly of ['package-lock.json', 'node_modules', 'npm i', 'npm/cli/issues']) {
      expect(error?.message).not.toContain(upstreamOnly);
    }
    expect(warnings[0]).toMatchObject({
      nativeFailures: [{ kind: 'unavailable', reason: napiAdvisory }],
    });
  });

  test('keeps every native failure cause, not only the last one', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    await expect(
      stopServerForRemoval(dir, {
        readProcessStart: (_pid, options) => {
          options?.onNativeFailure?.({
            kind: 'unavailable',
            reason: 'bundled loader failed to load: invalid ELF header',
          });
          options?.onNativeFailure?.({
            kind: 'unavailable',
            reason: 'the Windows native addon did not load',
          });
          return null;
        },
      }),
    ).rejects.toThrow('Cannot verify the identity');
    expect(isProcessAlive(pid)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: 40,
      lockDir: dir,
      lockPath: lockFilePath(dir, 'server'),
      lockPid: pid,
      status: 'alive',
      nativeFailures: [
        { kind: 'unavailable', reason: 'bundled loader failed to load: invalid ELF header' },
        { kind: 'unavailable', reason: 'the Windows native addon did not load' },
      ],
    });
  });

  test('omits the log pointer and the cause field when the reader reported none', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    await expect(stopServerForRemoval(dir, { readProcessStart: () => null })).rejects.toThrow(
      'Cannot verify the identity',
    );
    expect(isProcessAlive(pid)).toBe(true);
    expect(warnings[0]?.msg).not.toContain('~/.ok/logs');
    expect(warnings[0]).not.toHaveProperty('nativeFailures');
  });

  test('does not log a native failure when the liveness recheck accepts an exited process', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const isAlive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(
      await stopServerForRemoval(dir, {
        readProcessStart: (_pid, options) => {
          options?.onNativeFailure?.({
            kind: 'query-failed',
            reason: 'readProcessStart failed: OpenProcess: os error 87',
          });
          return null;
        },
        isAlive,
      }),
    ).toEqual({ stopped: 0, failed: [] });
    expect(warnings).toEqual([]);
    expect(isAlive).toHaveBeenCalledTimes(2);
    expect(isProcessAlive(pid)).toBe(true);
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
    expect(warnings[0]).toMatchObject({ lockPid: pid });
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
      const scanProcesses = vi.fn(async () => ({
        candidates: [],
        unavailable: ['POSIX tools unavailable'],
      }));
      expect(await stopServerForRemoval(dir, { scanProcesses })).toMatchObject({
        stopped: 0,
        failed: [],
        skipped: expect.stringContaining('stale'),
      });
      expect(scanProcesses).not.toHaveBeenCalled();
    },
  );
});
