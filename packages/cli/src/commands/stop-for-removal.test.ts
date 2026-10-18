import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
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
import {
  getMachineId,
  isProcessAlive,
  lockFilePath,
  type ProcessStart,
  scanLockProcesses,
} from '@inkeep/open-knowledge-server';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  processStartTokenFromOs,
  processStartTokenOffsetFromOs,
  readProcessStartFromOs,
} from '../../../../test-support/os-process-start.test-helper.ts';
import * as cliLogger from '../cli-logger.ts';
import { type HolderProcessStartOptions, readHolderProcessStart } from './holder-process-start.ts';
import { runRemoval } from './removal-plan.ts';
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
      JSON.stringify({
        pid,
        hostname: hostname(),
        machineId: getMachineId(),
        port: 0,
        startedAt: new Date().toISOString(),
      }),
    );
    return pid;
  }

  async function startUnreapedServer(): Promise<number> {
    const readyPath = join(dir, 'unreaped-ready');
    const serverPath = join(dir, 'unreaped-server.cjs');
    writeFileSync(
      serverPath,
      [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => { process.exit(0); });",
        "process.stdin.on('end', () => { process.exit(0); });",
        'process.stdin.resume();',
        'setInterval(() => {}, 1000);',
        `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        '',
      ].join('\n'),
    );
    const holderPath = join(dir, 'unreaped-holder.cjs');
    writeFileSync(
      holderPath,
      [
        "const { spawn } = require('node:child_process');",
        "const { existsSync, writeSync } = require('node:fs');",
        `const child = spawn(process.execPath, [${JSON.stringify(serverPath)}], { stdio: ['pipe', 'ignore', 'ignore'] });`,
        'const deadline = Date.now() + 10000;',
        `while (Date.now() < deadline && !existsSync(${JSON.stringify(readyPath)})) {`,
        '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
        '}',
        "writeSync(1, JSON.stringify({ pid: child.pid }) + '\\n');",
        'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
        '',
      ].join('\n'),
    );
    const holder = spawn(process.execPath, [holderPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(holder);
    const pid = await new Promise<number>((resolvePid, reject) => {
      let buffered = '';
      holder.stdout?.on('data', (chunk) => {
        buffered += String(chunk);
        const newline = buffered.indexOf('\n');
        if (newline !== -1) {
          resolvePid((JSON.parse(buffered.slice(0, newline)) as { pid: number }).pid);
        }
      });
      holder.once('exit', (code) =>
        reject(new Error(`Unreaped-server holder exited before reporting (code ${code})`)),
      );
    });
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({
        pid,
        hostname: hostname(),
        machineId: getMachineId(),
        port: 0,
        startedAt: new Date().toISOString(),
      }),
    );
    return pid;
  }

  function installPsCallLog(): { path: string; binDir: string } {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const path = join(dir, 'ps-calls.log');
    const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
    const shim = join(binDir, 'ps');
    writeFileSync(
      shim,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(path)}\nexec ${realPs} "$@"\n`,
    );
    chmodSync(shim, 0o755);
    writeFileSync(path, '');
    return { path, binDir };
  }

  async function fixtureExit(pid: number): Promise<ChildProcess> {
    const child = children.find((candidate) => candidate.pid === pid);
    if (child === undefined) throw new Error(`No fixture child for pid ${pid}`);
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    return child;
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

  test('skips a lock whose PID now belongs to a process started after the lock was written, without signalling it', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({ pid, hostname: hostname(), port: 0, startedAt: '2000-01-01T00:00:00.000Z' }),
    );
    expect(await stopServerForRemoval(dir)).toEqual({
      stopped: 0,
      failed: [],
      skipped: `Skipped stale lock at ${lockFilePath(dir, 'server')}; its recorded process ${pid} has exited and that process ID now belongs to another program, which was not signalled. No server was stopped.`,
    });
    expect(isProcessAlive(pid)).toBe(true);
    expect(warnings).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'judges a lock by its recorded process start even when its startedAt is later than the holder started',
    async () => {
      const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
      writeFileSync(
        lockFilePath(dir, 'server'),
        JSON.stringify({
          pid,
          hostname: hostname(),
          port: 0,
          startedAt: new Date().toISOString(),
          processStart: processStartTokenOffsetFromOs(pid, -5),
        }),
      );
      expect(await stopServerForRemoval(dir)).toMatchObject({
        stopped: 0,
        failed: [],
        skipped: expect.stringContaining('now belongs to another program'),
      });
      expect(isProcessAlive(pid)).toBe(true);
    },
  );

  test('does not signal a process when its lock has no acquisition timestamp', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const lockPath = lockFilePath(dir, 'server');
    writeFileSync(lockPath, JSON.stringify({ pid, hostname: hostname(), port: 0 }));
    const error = await stopServerForRemoval(dir).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toBe(
      `The start of process ${pid} cannot be compared with the start recorded in ${lockPath}, so it cannot be confirmed as the server that wrote the lock; ` +
        'it was not signalled. ' +
        `Before ending process ${pid} yourself, confirm that it is an OpenKnowledge server. ` +
        `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath} and retry cleanup.`,
    );
    expect(isProcessAlive(pid)).toBe(true);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        pid: process.pid,
        lockPid: pid,
        cause: 'process-start-incomparable',
        msg: 'stop declined: lock holder identity unverified',
      }),
    );
  });

  test.skipIf(process.platform === 'win32')(
    'stops a holder matching the recorded process start even when its lock has no acquisition timestamp',
    async () => {
      const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
      writeFileSync(
        lockFilePath(dir, 'server'),
        JSON.stringify({
          pid,
          hostname: hostname(),
          port: 0,
          processStart: processStartTokenFromOs(pid),
        }),
      );
      expect(await stopServerForRemoval(dir)).toEqual({ stopped: 1, failed: [] });
      const exited = await fixtureExit(pid);
      expect(exited.signalCode ?? exited.exitCode).not.toBe(0);
    },
  );

  test.each([
    ['linux', '/proc'],
    ['darwin', 'macOS reads the process start with ps, and that read failed'],
  ] as const)(
    'explains the %s probe recovery when the process start probe is unavailable',
    async (platform, expected) => {
      const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
      const error = await stopServerForRemoval(dir, {
        platform,
        readProcessStart: () => null,
      }).then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      expect(error?.message).toContain(expected);
      expect(error?.message).toContain(`remove ${lockFilePath(dir, 'server')} and retry cleanup.`);
      expect(error?.message).not.toContain('--force');
      expect(isProcessAlive(pid)).toBe(true);
      expect(warnings).toEqual([
        expect.objectContaining({
          level: 40,
          lockDir: dir,
          lockPath: lockFilePath(dir, 'server'),
          pid: process.pid,
          lockPid: pid,
          platform,
          cause: 'process-start-unreadable',
          msg: 'stop declined: lock holder identity unverified',
        }),
      ]);
    },
  );

  test('without a CLI logger, as the desktop removes a project, the refusal points at no log', async () => {
    vi.spyOn(cliLogger, 'getCliLogger').mockReturnValue(undefined);
    await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const error = await stopServerForRemoval(dir, {
      readProcessStart: (_pid, options) => {
        options?.onNativeFailure?.({
          kind: 'query-failed',
          reason: 'readProcessStart failed: OpenProcess: os error 5',
        });
        return null;
      },
    }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toContain('Could not read when process');
    expect(error?.message).not.toContain('recorded in');
    expect(error?.message).not.toContain('~/.ok/logs');
  });

  test('records the native identity failure cause in the CLI log, never in the refusal a user reads', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const error = await stopServerForRemoval(dir, {
      readProcessStart: (_pid, options) => {
        options?.onNativeFailure?.({
          kind: 'query-failed',
          reason: 'readProcessStart failed: OpenProcess: os error 5',
        });
        return null;
      },
    }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toContain('Could not read when process');
    expect(isProcessAlive(pid)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      cause: 'process-start-unreadable',
      nativeFailures: [
        { kind: 'query-failed', reason: 'readProcessStart failed: OpenProcess: os error 5' },
      ],
    });
    expect(error?.message).toContain(lockFilePath(dir, 'server'));
    expect(error?.message).not.toContain('OpenProcess: os error 5');
    expect(error?.message).toContain('recorded in the CLI log under ~/.ok/logs');
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
      const error = await stopServerForRemoval(dir, {
        platform: 'win32',
        readProcessStart: (_pid, options) => {
          options?.onNativeFailure?.({ kind, reason: 'probe detail' });
          return null;
        },
      }).then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      expect(error?.message).toContain(expected);
      expect(isProcessAlive(pid)).toBe(true);
      expect(error?.message).not.toContain(absent);
    },
  );

  test('names no remedy on win32 when nothing was reported', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const error = await stopServerForRemoval(dir, {
      platform: 'win32',
      readProcessStart: () => null,
    }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toContain(
      `it was not signalled. Before ending process ${pid} yourself, confirm that it is an OpenKnowledge server.`,
    );
    expect(isProcessAlive(pid)).toBe(true);
    expect(error?.message).not.toContain('Reinstall OpenKnowledge');
    expect(error?.message).not.toContain('refused the query');
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
    ).rejects.toThrow('Could not read when process');
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
    expect(error?.message).toContain('Could not read when process');
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
    ).rejects.toThrow('Could not read when process');
    expect(isProcessAlive(pid)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: 40,
      lockDir: dir,
      lockPath: lockFilePath(dir, 'server'),
      pid: process.pid,
      lockPid: pid,
      cause: 'process-start-unreadable',
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
    const error = await stopServerForRemoval(dir, { readProcessStart: () => null }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toContain('Could not read when process');
    expect(isProcessAlive(pid)).toBe(true);
    expect(error?.message).not.toContain('~/.ok/logs');
    expect(warnings[0]).not.toHaveProperty('nativeFailures');
  });

  test('does not log a native failure when the holder exits between inspection and the stop signal', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const start = readHolderProcessStart(pid);
    if (start === null) throw new Error('Could not read fixture process start time');
    const readProcessStart = vi
      .fn<(pid: number, options?: HolderProcessStartOptions) => ProcessStart | null>()
      .mockReturnValueOnce(start)
      .mockImplementation((_pid, options) => {
        options?.onNativeFailure?.({
          kind: 'query-failed',
          reason: 'readProcessStart failed: OpenProcess: os error 87',
        });
        return null;
      });
    const isAlive = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    expect(await stopServerForRemoval(dir, { readProcessStart, isAlive })).toEqual({
      stopped: 0,
      failed: [],
    });
    expect(readProcessStart).toHaveBeenCalledTimes(2);
    expect(readProcessStart.mock.calls[1]?.[1]?.onNativeFailure).toBeTypeOf('function');
    expect(warnings).toEqual([]);
    expect(isAlive).toHaveBeenCalledTimes(3);
    expect(isProcessAlive(pid)).toBe(true);
  });

  test('skips the lock when its holder exits while inspection reads its start', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const isAlive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await stopServerForRemoval(dir, { readProcessStart: () => null, isAlive })).toEqual({
      stopped: 0,
      failed: [],
      skipped: `Skipped stale lock at ${lockFilePath(dir, 'server')}; its recorded local process ${pid} has exited. No server was stopped.`,
    });
    expect(isAlive).toHaveBeenCalledTimes(2);
    expect(isProcessAlive(pid)).toBe(true);
  });

  test('allows a process older than its lock even when start times have only second precision', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const start = readHolderProcessStart(pid);
    if (start === null) throw new Error('Could not read fixture process start time');
    const startSecond = Math.floor(start.startedAtMs / 1000) * 1000;
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({
        pid,
        hostname: hostname(),
        machineId: getMachineId(),
        port: 0,
        startedAt: new Date(startSecond + 999).toISOString(),
      }),
    );
    expect(
      await stopServerForRemoval(dir, {
        readProcessStart: () => ({ ...start, startedAtMs: startSecond }),
      }),
    ).toEqual({
      stopped: 1,
      failed: [],
    });
    const exited = await fixtureExit(pid);
    expect(exited.signalCode ?? exited.exitCode).not.toBe(0);
  });

  describe('a same-machine lock that records no process start', () => {
    const MINUTE_MS = 60_000;

    async function startSignalRecordingServer(): Promise<{
      pid: number;
      receivedSigterm: () => boolean;
    }> {
      const marker = join(dir, 'sigterm-received');
      const pid = await startServer(`
        const fs = require('node:fs');
        process.on('SIGTERM', () => {
          fs.writeFileSync(${JSON.stringify(marker)}, 'SIGTERM');
          process.exit(0);
        });
        process.send('ready');
        setInterval(() => {}, 1000);
      `);
      return { pid, receivedSigterm: () => existsSync(marker) };
    }

    function writeLockWithoutProcessStart(pid: number, startedAtMs: number): void {
      writeFileSync(
        lockFilePath(dir, 'server'),
        JSON.stringify({
          pid,
          hostname: hostname(),
          machineId: getMachineId(),
          port: 0,
          startedAt: new Date(startedAtMs).toISOString(),
        }),
      );
    }

    function holderStart(clock: ProcessStart['clock'], startedAtMs: number): ProcessStart {
      if (clock === 'creation') return { startedAtMs, clock };
      const bootedAtMs = startedAtMs - 60 * MINUTE_MS;
      return {
        startedAtMs,
        clock,
        startTicks: (startedAtMs - bootedAtMs) / 10,
        bootId: 'fixture-boot-id',
      };
    }

    function removalReport(
      options?: Parameters<typeof stopServerForRemoval>[1],
    ): Promise<{ stopped: number; failed: unknown[]; explanation: string | undefined }> {
      return stopServerForRemoval(dir, options).then(
        ({ stopped, failed, skipped }) => ({ stopped, failed, explanation: skipped }),
        (err: unknown) => ({
          stopped: 0,
          failed: [],
          explanation: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    test.each([
      { clock: 'creation', platform: 'darwin', gapMs: 5_000, gap: '5 s' },
      { clock: 'boot-derived', platform: 'linux', gapMs: MINUTE_MS, gap: '60 s' },
    ] as const)(
      'does not signal a holder whose $clock-clock start is $gap after the lock was written, and reports it was not signalled',
      async ({ clock, platform, gapMs }) => {
        const { pid, receivedSigterm } = await startSignalRecordingServer();
        const lockWrittenAtMs = Date.now() - 10 * MINUTE_MS;
        writeLockWithoutProcessStart(pid, lockWrittenAtMs);

        const report = await removalReport({
          platform,
          readProcessStart: () => holderStart(clock, lockWrittenAtMs + gapMs),
        });

        expect(receivedSigterm(), 'the removal sent SIGTERM to the holder').toBe(false);
        expect(isProcessAlive(pid)).toBe(true);
        expect(report).toEqual({
          stopped: 0,
          failed: [],
          explanation: expect.stringMatching(new RegExp(`\\b${pid}\\b.*not signalled`)),
        });
      },
    );

    test.each([
      { clock: 'creation', platform: 'darwin', gapMs: 5_000, gap: '5 s' },
      { clock: 'boot-derived', platform: 'linux', gapMs: MINUTE_MS, gap: '60 s' },
    ] as const)(
      'still stops a holder whose $clock-clock start is $gap before the lock was written',
      async ({ clock, platform, gapMs }) => {
        const { pid, receivedSigterm } = await startSignalRecordingServer();
        const lockWrittenAtMs = Date.now() - 10 * MINUTE_MS;
        writeLockWithoutProcessStart(pid, lockWrittenAtMs);

        expect(
          await stopServerForRemoval(dir, {
            platform,
            readProcessStart: () => holderStart(clock, lockWrittenAtMs - gapMs),
          }),
        ).toEqual({ stopped: 1, failed: [] });
        const exited = await fixtureExit(pid);
        if (process.platform !== 'win32') {
          expect(receivedSigterm()).toBe(true);
          expect(exited.exitCode).toBe(0);
        }
      },
    );

    test.skipIf(process.platform === 'win32')(
      'does not signal a live process that started seconds after the lock was written, read from the OS',
      async () => {
        const { pid, receivedSigterm } = await startSignalRecordingServer();
        writeLockWithoutProcessStart(pid, readProcessStartFromOs(pid).startedAtMs - 5_000);

        const report = await removalReport();

        expect(receivedSigterm(), 'the removal sent SIGTERM to the holder').toBe(false);
        expect(isProcessAlive(pid)).toBe(true);
        expect(report).toEqual({
          stopped: 0,
          failed: [],
          explanation: expect.stringMatching(new RegExp(`\\b${pid}\\b.*not signalled`)),
        });
      },
    );
  });

  test('reads the recorded process start again at the signal and leaves a replaced holder running', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const start = readHolderProcessStart(pid);
    if (start === null) throw new Error('Could not read fixture process start time');
    const readProcessStart = vi
      .fn()
      .mockReturnValueOnce(start)
      .mockReturnValue({ ...start, startedAtMs: start.startedAtMs + 36 * 60 * 60 * 1000 });

    expect(await stopServerForRemoval(dir, { readProcessStart })).toEqual({
      stopped: 0,
      failed: [],
    });
    expect(isProcessAlive(pid)).toBe(true);
  });

  test('refuses a lock from before machine IDs with the cleanup remedy and no restart advice', async () => {
    const pid = await startServer(`
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const lockPath = lockFilePath(dir, 'server');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid, hostname: hostname(), port: 0, startedAt: new Date().toISOString() }),
    );

    const error = await stopServerForRemoval(dir).then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(error?.message).toBe(
      `The server lock at ${lockPath} records neither a machine ID nor a process start, as locks written by version 0.25.0 and earlier do, so process ${pid} cannot be confirmed as the server that wrote it; ` +
        'it was not signalled. ' +
        `Before ending process ${pid} yourself, confirm that it is an OpenKnowledge server. ` +
        `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath} and retry cleanup.`,
    );
    expect(isProcessAlive(pid)).toBe(true);
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
    expect((await fixtureExit(pid)).exitCode).toBe(0);
  });

  test.skipIf(process.platform === 'win32')(
    'counts a process left defunct by the wait as stopped, without reading its state on every poll',
    async () => {
      const psCalls = installPsCallLog();
      const pid = await startUnreapedServer();
      const originalPath = process.env.PATH;
      process.env.PATH = `${psCalls.binDir}:${originalPath ?? ''}`;
      let outcome: Awaited<ReturnType<typeof stopServerForRemoval>>;
      try {
        outcome = await stopServerForRemoval(dir, { timeoutMs: 400, pollIntervalMs: 10 });
      } finally {
        process.env.PATH = originalPath;
      }
      expect(outcome).toEqual({ stopped: 1, failed: [] });
      const stateReads = readFileSync(psCalls.path, 'utf8')
        .split('\n')
        .filter((call) => call.includes('stat=') && call.includes(String(pid)));
      expect(stateReads.length).toBeLessThanOrEqual(3);
    },
  );

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
