import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigSchema,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  ServerLockCollisionError,
  type ServerLockMetadata,
} from '@inkeep/open-knowledge-server';
import { RemoteCompanionError } from '../remote-project-bootstrap.ts';
import {
  formatRemoteErrorLine,
  formatRemoteInspectLine,
  formatRemoteReadyLine,
  MAX_REMOTE_READY_LINE_BYTES,
  parseRemoteCompanionCommand,
  parseRemoteCompanionNonce,
  REMOTE_ERROR_PREFIX,
  REMOTE_INSPECT_PREFIX,
  REMOTE_READY_PREFIX,
  type RemoteReadyPayload,
  type RemoteServeDeps,
  readRemoteTerminalConsent,
  runRemoteServe,
  shouldWatchRemoteStdin,
  waitForRemoteTerminalConsent,
} from './remote.ts';

const config = ConfigSchema.parse({});
const NONCE = 'A'.repeat(43);

function liveLock(overrides: Partial<ServerLockMetadata> = {}): ServerLockMetadata {
  return {
    pid: process.pid,
    hostname: 'remote-host',
    port: 43123,
    startedAt: '2026-07-13T00:00:00.000Z',
    worktreeRoot: '/project',
    kind: 'interactive',
    capabilities: ['http', 'ws'],
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    ...overrides,
  };
}

function parseReadyLine(line: string): RemoteReadyPayload {
  expect(line.startsWith(REMOTE_READY_PREFIX)).toBe(true);
  expect(line.endsWith('\n')).toBe(true);
  expect(line.slice(0, -1)).not.toContain('\n');
  return JSON.parse(line.slice(REMOTE_READY_PREFIX.length)) as RemoteReadyPayload;
}

describe('parseRemoteCompanionCommand', () => {
  const expectedPath = '/srv/wiki';
  const encodedExpectedPath = Buffer.from(expectedPath).toString('base64url');

  test.each([
    [['inspect'], { name: 'inspect' }],
    [['serve'], { name: 'serve', initialize: false, waitForOwnerExit: false }],
    [
      ['serve', '--wait-for-owner-exit'],
      { name: 'serve', initialize: false, waitForOwnerExit: true },
    ],
    [
      ['serve', '--initialize', '--expected-path', encodedExpectedPath],
      { name: 'serve', initialize: true, expectedPath, waitForOwnerExit: false },
    ],
    [['terminal-consent'], { name: 'terminal-consent' }],
  ] as const)('parses the internal command %j', (args, expected) => {
    expect(parseRemoteCompanionCommand(args)).toEqual(expected);
  });

  test.each([
    { args: [] },
    { args: ['serve', '--initialize'] },
    { args: ['serve', '--port', '42'] },
    { args: ['serve', '--initialize', '--initialize'] },
    { args: ['serve', '--initialize', '--expected-path', '%%%'] },
    { args: ['other'] },
  ])('rejects unsupported arguments %j', ({ args }) => {
    expect(() => parseRemoteCompanionCommand(args)).toThrow(RemoteCompanionError);
  });
});

describe('parseRemoteCompanionNonce', () => {
  test('accepts one exact 256-bit base64url nonce argument', () => {
    expect(parseRemoteCompanionNonce(['--nonce', NONCE, 'inspect'])).toBe(NONCE);
  });

  test.each([
    { args: [] },
    { args: ['inspect'] },
    { args: ['--nonce'] },
    { args: ['--nonce', 'short', 'inspect'] },
    { args: ['--nonce', `${'A'.repeat(42)}+`, 'inspect'] },
  ])('rejects an invalid invocation prefix %j', ({ args }) => {
    expect(() => parseRemoteCompanionNonce(args)).toThrow(RemoteCompanionError);
  });
});

describe('remote companion frames', () => {
  test('emits a compact, single-line, prefixed JSON record', () => {
    const line = formatRemoteReadyLine({
      v: 1,
      nonce: NONCE,
      port: 1234,
      projectPath: '/srv/a project',
      platform: 'linux',
      pathSeparator: '/',
      protocolVersion: 1,
      runtimeVersion: '0.30.0',
      capabilities: ['http', 'ws'],
      owned: true,
    });

    expect(parseReadyLine(line)).toEqual({
      v: 1,
      nonce: NONCE,
      port: 1234,
      projectPath: '/srv/a project',
      platform: 'linux',
      pathSeparator: '/',
      protocolVersion: 1,
      runtimeVersion: '0.30.0',
      capabilities: ['http', 'ws'],
      owned: true,
    });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_REMOTE_READY_LINE_BYTES);
  });

  test('rejects an oversized frame instead of writing an unbounded line', () => {
    expect(() =>
      formatRemoteReadyLine({
        v: 1,
        nonce: NONCE,
        port: 1234,
        projectPath: `/${'x'.repeat(MAX_REMOTE_READY_LINE_BYTES)}`,
        platform: 'linux',
        pathSeparator: '/',
        protocolVersion: 1,
        runtimeVersion: RUNTIME_VERSION,
        capabilities: ['http', 'ws'],
        owned: true,
      }),
    ).toThrow('Remote companion frame is too large');
  });

  test('emits bounded inspect and code-only error frames', () => {
    const inspection = formatRemoteInspectLine(NONCE, {
      v: 1,
      selectedPath: '/srv/wiki/notes',
      projectPath: '/srv/wiki',
      initialized: true,
    });
    const error = formatRemoteErrorLine(NONCE, 'project-uninitialized');

    expect(inspection).toBe(
      `${REMOTE_INSPECT_PREFIX}{"v":1,"selectedPath":"/srv/wiki/notes","projectPath":"/srv/wiki","initialized":true,"nonce":"${NONCE}"}\n`,
    );
    expect(error).toBe(
      `${REMOTE_ERROR_PREFIX}{"v":1,"nonce":"${NONCE}","code":"project-uninitialized"}\n`,
    );
    expect(Buffer.byteLength(inspection)).toBeLessThanOrEqual(MAX_REMOTE_READY_LINE_BYTES);
    expect(Buffer.byteLength(error)).toBeLessThanOrEqual(MAX_REMOTE_READY_LINE_BYTES);
  });
});

describe('remote terminal consent', () => {
  test('refuses only an explicit project-local terminal opt-out', () => {
    const project = mkdtempSync(join(tmpdir(), 'ok-remote-consent-'));
    try {
      const localDir = join(project, '.ok', 'local');
      mkdirSync(localDir, { recursive: true });
      writeFileSync(join(localDir, 'config.yml'), 'terminal:\n  enabled: false\n');
      expect(readRemoteTerminalConsent(project)).toBe(false);

      writeFileSync(join(localDir, 'config.yml'), 'terminal:\n  enabled: true\n');
      expect(readRemoteTerminalConsent(project)).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('fails loudly when the project-local terminal override is malformed', () => {
    const project = mkdtempSync(join(tmpdir(), 'ok-remote-consent-'));
    try {
      const localDir = join(project, '.ok', 'local');
      mkdirSync(localDir, { recursive: true });
      writeFileSync(join(localDir, 'config.yml'), 'terminal: [');

      expect(() => readRemoteTerminalConsent(project)).toThrow(RemoteCompanionError);
      try {
        readRemoteTerminalConsent(project);
      } catch (error) {
        expect(error).toMatchObject({ code: 'config-invalid' });
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('fails loudly when the project-local terminal override cannot be read as a file', () => {
    const project = mkdtempSync(join(tmpdir(), 'ok-remote-consent-'));
    try {
      mkdirSync(join(project, '.ok', 'local', 'config.yml'), { recursive: true });

      expect(() => readRemoteTerminalConsent(project)).toThrow(RemoteCompanionError);
      try {
        readRemoteTerminalConsent(project);
      } catch (error) {
        expect(error).toMatchObject({ code: 'config-invalid' });
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('uses the default allow policy only when no local override exists', () => {
    const project = mkdtempSync(join(tmpdir(), 'ok-remote-consent-'));
    try {
      expect(readRemoteTerminalConsent(project)).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('waits for a debounced opt-out lift', async () => {
    const reads = [false, false, true];
    const sleeps: number[] = [];
    const allowed = await waitForRemoteTerminalConsent('/project', {
      timeoutMs: 10_000,
      intervalMs: 50,
      read: () => reads.shift() ?? true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(allowed).toBe(true);
    expect(sleeps).toEqual([50, 50]);
  });

  test('returns false immediately when an opt-out remains and grace is disabled', async () => {
    expect(
      await waitForRemoteTerminalConsent('/project', {
        timeoutMs: 0,
        read: () => false,
      }),
    ).toBe(false);
  });
});

describe('shouldWatchRemoteStdin', () => {
  test.each([
    [{ SSH_CONNECTION: 'client 1 server 2' }, false, true],
    [{ SSH_CLIENT: 'client 1 2' }, undefined, true],
    [{ SSH_TTY: '/dev/pts/1' }, false, true],
    [{}, false, false],
    [{ SSH_CONNECTION: 'client 1 server 2' }, true, false],
  ] as const)('detects SSH pipe lifetime for env=%j tty=%j', (env, stdinIsTTY, expected) => {
    expect(shouldWatchRemoteStdin(env, stdinIsTTY)).toBe(expected);
  });
});

describe('runRemoteServe', () => {
  test('refuses every pre-existing live owner without booting or emitting readiness', async () => {
    const stdout: string[] = [];
    let bootCalls = 0;

    await expect(
      runRemoteServe({
        config,
        cwd: '/logical/project',
        resolvedContentDir: '/canonical/project',
        nonce: NONCE,
        deps: {
          canonicalize: (path) => (path === '/logical/project' ? '/canonical/project' : path),
          lockDir: (projectPath) => `${projectPath}/.ok/local`,
          readLock: () => liveLock({ port: 54321, worktreeRoot: '/canonical/project' }),
          boot: async () => {
            bootCalls += 1;
            throw new Error('must not boot');
          },
          writeStdout: (line) => stdout.push(line),
        },
      }),
    ).rejects.toMatchObject({ code: 'startup-failed' });
    expect(bootCalls).toBe(0);
    expect(stdout).toEqual([]);
  });

  test('waits only when explicitly replacing an owner, then starts a wholly owned server', async () => {
    const stdout: string[] = [];
    let waitCalls = 0;

    const result = await runRemoteServe({
      config,
      cwd: '/project',
      resolvedContentDir: '/project',
      nonce: NONCE,
      waitForOwnerExit: true,
      deps: {
        canonicalize: (path) => path,
        readLock: () => liveLock(),
        waitForLockRelease: async () => {
          waitCalls += 1;
          return true;
        },
        boot: async () => ({
          port: 54321,
          ready: Promise.resolve(),
          destroy: async () => {},
        }),
        writeStdout: (line) => stdout.push(line),
        watchStdinForDisconnect: false,
      },
    });

    expect(waitCalls).toBe(1);
    expect(result).toMatchObject({ owned: true, port: 54321 });
    expect(parseReadyLine(stdout[0] ?? '')).toMatchObject({ nonce: NONCE, owned: true });
    await result.shutdown('SIGTERM');
  });

  test('fails explicitly when the previous owner does not exit before the deadline', async () => {
    await expect(
      runRemoteServe({
        config,
        cwd: '/project',
        resolvedContentDir: '/project',
        nonce: NONCE,
        waitForOwnerExit: true,
        deps: {
          canonicalize: (path) => path,
          readLock: () => liveLock(),
          waitForLockRelease: async () => false,
          boot: async () => {
            throw new Error('must not boot');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'startup-failed' });
  });

  test('rejects an acquisition collision instead of trusting the winner', async () => {
    const stdout: string[] = [];
    const racedLock = liveLock();
    const collision = new ServerLockCollisionError(racedLock, '/canonical/project/server.lock');

    await expect(
      runRemoteServe({
        config,
        cwd: '/canonical/project',
        resolvedContentDir: '/canonical/project',
        nonce: NONCE,
        deps: {
          canonicalize: (path) => path,
          readLock: () => null,
          boot: async () => {
            throw collision;
          },
          writeStdout: (line) => stdout.push(line),
        },
      }),
    ).rejects.toMatchObject({ code: 'startup-failed', cause: collision });

    expect(stdout).toEqual([]);
  });

  test('boots loopback-only on port 0, waits for readiness, and emits owned=true once', async () => {
    const stdout: string[] = [];
    const signalListeners = new Map<NodeJS.Signals, () => void | Promise<void>>();
    const removedSignals: NodeJS.Signals[] = [];
    let destroyCalls = 0;
    let stdinRegistrations = 0;
    let stdinResumes = 0;
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let bootOptions: Parameters<RemoteServeDeps['boot']>[0] | undefined;

    const pending = runRemoteServe({
      config,
      cwd: '/logical/project',
      resolvedContentDir: '/canonical/project/content',
      nonce: NONCE,
      deps: {
        canonicalize: () => '/canonical/project',
        readLock: () => null,
        boot: async (options) => {
          bootOptions = options;
          return {
            port: 45678,
            ready,
            destroy: async () => {
              destroyCalls += 1;
            },
          };
        },
        writeStdout: (line) => stdout.push(line),
        onceSignal: (signal, listener) => {
          signalListeners.set(signal, listener);
        },
        offSignal: (signal) => {
          removedSignals.push(signal);
          signalListeners.delete(signal);
        },
        watchStdinForDisconnect: false,
        onceStdin: () => {
          stdinRegistrations += 1;
        },
        resumeStdin: () => {
          stdinResumes += 1;
        },
        platform: 'linux',
        pathSeparator: '/',
        protocolVersion: 1,
        runtimeVersion: '0.30.0',
      },
    });

    await Promise.resolve();
    expect(stdout).toEqual([]);
    resolveReady?.();
    const result = await pending;

    expect(bootOptions).toMatchObject({
      cwd: '/canonical/project',
      resolvedContentDir: '/canonical/project/content',
      host: '127.0.0.1',
      port: 0,
      skipUiAutoSpawn: true,
      serveContentAssets: true,
      watcherBackend: 'chokidar',
    });
    expect(result.owned).toBe(true);
    expect(result.port).toBe(45678);
    expect(destroyCalls).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(parseReadyLine(stdout[0] ?? '').owned).toBe(true);
    expect(stdinRegistrations).toBe(0);
    expect(stdinResumes).toBe(0);

    await signalListeners.get('SIGTERM')?.();
    expect(destroyCalls).toBe(1);
    expect(removedSignals).toEqual(['SIGINT', 'SIGTERM']);

    if (result.owned) await result.shutdown('SIGINT');
    expect(destroyCalls).toBe(1);
  });

  test('uses SSH stdin EOF as an idempotent owned-server lifetime signal', async () => {
    const stdinListeners = new Map<'end' | 'close', () => void | Promise<void>>();
    const removedStdinEvents: Array<'end' | 'close'> = [];
    const removedSignals: NodeJS.Signals[] = [];
    let destroyCalls = 0;
    let resumeCalls = 0;
    let pauseCalls = 0;

    const result = await runRemoteServe({
      config,
      cwd: '/project',
      resolvedContentDir: '/project',
      nonce: NONCE,
      deps: {
        canonicalize: (path) => path,
        readLock: () => null,
        boot: async () => ({
          port: 45678,
          ready: Promise.resolve(),
          destroy: async () => {
            destroyCalls += 1;
          },
        }),
        writeStdout: () => {},
        onceSignal: () => {},
        offSignal: (signal) => {
          removedSignals.push(signal);
        },
        watchStdinForDisconnect: true,
        onceStdin: (event, listener) => {
          stdinListeners.set(event, listener);
        },
        offStdin: (event) => {
          removedStdinEvents.push(event);
          stdinListeners.delete(event);
        },
        resumeStdin: () => {
          resumeCalls += 1;
        },
        pauseStdin: () => {
          pauseCalls += 1;
        },
      },
    });

    expect(result.owned).toBe(true);
    expect([...stdinListeners.keys()]).toEqual(['end', 'close']);
    expect(resumeCalls).toBe(1);

    const onEnd = stdinListeners.get('end');
    const onClose = stdinListeners.get('close');
    expect(onEnd).toBeDefined();
    expect(onClose).toBeDefined();
    await Promise.all([onEnd?.(), onClose?.()]);

    expect(destroyCalls).toBe(1);
    expect(removedSignals).toEqual(['SIGINT', 'SIGTERM']);
    expect(removedStdinEvents).toEqual(['end', 'close']);
    expect(pauseCalls).toBe(1);
    expect(stdinListeners.size).toBe(0);

    if (result.owned) await result.shutdown('SIGTERM');
    expect(destroyCalls).toBe(1);
    expect(pauseCalls).toBe(1);
  });

  test('forces a remote companion to exit when server teardown hangs', async () => {
    const stdinListeners = new Map<'end' | 'close', () => void | Promise<void>>();
    let deadline: (() => void) | undefined;
    let forcedExitCode: number | undefined;

    await runRemoteServe({
      config,
      cwd: '/project',
      resolvedContentDir: '/project',
      nonce: NONCE,
      deps: {
        canonicalize: (path) => path,
        readLock: () => null,
        boot: async () => ({
          port: 45678,
          ready: Promise.resolve(),
          destroy: () => new Promise<void>(() => {}),
        }),
        writeStdout: () => {},
        onceSignal: () => {},
        offSignal: () => {},
        watchStdinForDisconnect: true,
        onceStdin: (event, listener) => stdinListeners.set(event, listener),
        offStdin: (event) => stdinListeners.delete(event),
        resumeStdin: () => {},
        pauseStdin: () => {},
        scheduleShutdownDeadline: (listener) => {
          deadline = listener;
          return () => {
            deadline = undefined;
          };
        },
        forceExit: (code) => {
          forcedExitCode = code;
        },
      },
    });

    void stdinListeners.get('end')?.();
    expect(deadline).toBeDefined();
    deadline?.();
    expect(forcedExitCode).toBe(1);
  });

  test('destroys a partial boot when async readiness rejects', async () => {
    let destroyCalls = 0;
    const failure = new Error('watcher init failed');

    await expect(
      runRemoteServe({
        config,
        cwd: '/project',
        resolvedContentDir: '/project',
        nonce: NONCE,
        deps: {
          canonicalize: (path) => path,
          readLock: () => null,
          boot: async () => ({
            port: 45678,
            ready: Promise.reject(failure),
            destroy: async () => {
              destroyCalls += 1;
            },
          }),
          writeStdout: () => {
            throw new Error('must not emit readiness');
          },
        },
      }),
    ).rejects.toBe(failure);

    expect(destroyCalls).toBe(1);
  });

  test('does not hide cleanup failure after async readiness rejects', async () => {
    const startupFailure = new Error('watcher init failed');
    const cleanupFailure = new Error('listener close failed');

    try {
      await runRemoteServe({
        config,
        cwd: '/project',
        resolvedContentDir: '/project',
        nonce: NONCE,
        deps: {
          canonicalize: (path) => path,
          readLock: () => null,
          boot: async () => ({
            port: 45678,
            ready: Promise.reject(startupFailure),
            destroy: async () => {
              throw cleanupFailure;
            },
          }),
          writeStdout: () => {
            throw new Error('must not emit readiness');
          },
        },
      });
      throw new Error('expected runRemoteServe to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([startupFailure, cleanupFailure]);
    }
  });
});
