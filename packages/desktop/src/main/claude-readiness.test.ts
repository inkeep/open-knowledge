import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  cliProbeArgs,
  type ProbeChild,
  type ProbeTimers,
  runLoginShellProbe,
  runWindowsPathProbe,
} from './claude-readiness.ts';

const probeLog = vi.hoisted(() => {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
});
vi.mock('./desktop-logger.ts', () => ({ getLogger: () => probeLog }));

function settleRecords(): Record<string, unknown>[] {
  return [...probeLog.info.mock.calls, ...probeLog.warn.mock.calls]
    .map(([attrs]) => attrs as Record<string, unknown>)
    .filter((attrs) => 'outcome' in attrs);
}

function unknownSettleRecords(): Record<string, unknown>[] {
  return probeLog.warn.mock.calls
    .map(([attrs]) => attrs as Record<string, unknown>)
    .filter((attrs) => attrs.outcome === 'unknown');
}

function makeFakeChild() {
  let exitCb: ((code: number | null) => void) | null = null;
  let errorCb: ((err: Error) => void) | null = null;
  const child: ProbeChild = {
    onExit: (cb) => {
      exitCb = cb;
    },
    onError: (cb) => {
      errorCb = cb;
    },
    kill: () => {},
  };
  return {
    child,
    emitExit: (code: number | null) => exitCb?.(code),
    emitError: (err: Error) => errorCb?.(err),
  };
}

function makeFakeTimers() {
  let scheduled: (() => void) | null = null;
  const timers: ProbeTimers = {
    setTimer: (cb) => {
      scheduled = cb;
      return 'token';
    },
    clearTimer: () => {},
  };
  return { timers, fireTimeout: () => scheduled?.() };
}

const CODEX_PROBE_ARGS = cliProbeArgs('codex', process.platform);

describe('probe settle observability (a not-found must be distinguishable from a real absence)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each([
    [0, 'present'],
    [1, 'not-found'],
    [127, 'not-found'],
  ])(
    'an exit of %i settles as %s, naming the shell and the binary it probed',
    async (code, outcome) => {
      const { child, emitExit } = makeFakeChild();
      const { timers } = makeFakeTimers();
      const probe = runLoginShellProbe(
        () => child,
        '/bin/zsh',
        timers,
        undefined,
        CODEX_PROBE_ARGS,
      );
      emitExit(code);
      expect(await probe).toBe(code);
      expect(settleRecords()).toEqual([
        {
          label: 'interactive-shell',
          shell: '/bin/zsh',
          args: CODEX_PROBE_ARGS,
          outcome,
          exitCode: code,
        },
      ]);
    },
  );

  test('two probes of different binaries settle as separately attributable records', async () => {
    const claudeArgs = cliProbeArgs('claude', process.platform);
    for (const args of [claudeArgs, CODEX_PROBE_ARGS]) {
      const { child, emitExit } = makeFakeChild();
      const { timers } = makeFakeTimers();
      const probe = runLoginShellProbe(() => child, '/bin/zsh', timers, undefined, args);
      emitExit(1);
      await probe;
    }
    expect(settleRecords().map((record) => record.args)).toEqual([claudeArgs, CODEX_PROBE_ARGS]);
  });

  test('a timeout settles as unknown and records it once, even when a late exit follows', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers, fireTimeout } = makeFakeTimers();
    const probe = runLoginShellProbe(() => child, '/bin/zsh', timers, 5000, CODEX_PROBE_ARGS);
    fireTimeout();
    emitExit(0);
    expect(await probe).toBe(null);
    expect(settleRecords()).toEqual([
      {
        label: 'interactive-shell',
        shell: '/bin/zsh',
        args: CODEX_PROBE_ARGS,
        timedOut: true,
        timeoutMs: 5000,
        outcome: 'unknown',
        exitCode: null,
      },
    ]);
  });

  test('a child that fails to run settles as unknown, alongside the warn', async () => {
    const { child, emitError } = makeFakeChild();
    const { timers } = makeFakeTimers();
    const failure = new Error('ENOENT');
    const probe = runLoginShellProbe(() => child, '/bin/zsh', timers, undefined, CODEX_PROBE_ARGS);
    emitError(failure);
    expect(await probe).toBe(null);
    expect(settleRecords()).toEqual([
      {
        label: 'interactive-shell',
        shell: '/bin/zsh',
        args: CODEX_PROBE_ARGS,
        err: failure,
        failurePhase: 'onError',
        outcome: 'unknown',
        exitCode: null,
      },
    ]);
    expect(unknownSettleRecords()).toHaveLength(1);
    expect(probeLog.warn.mock.calls).toHaveLength(1);
  });

  test('a spawn that throws settles as unknown rather than leaving no verdict at all', async () => {
    const { timers } = makeFakeTimers();
    const failure = new Error('EACCES');
    const probe = runLoginShellProbe(
      () => {
        throw failure;
      },
      '/bin/zsh',
      timers,
      undefined,
      CODEX_PROBE_ARGS,
    );
    expect(await probe).toBe(null);
    expect(settleRecords()).toEqual([
      {
        label: 'interactive-shell',
        shell: '/bin/zsh',
        args: CODEX_PROBE_ARGS,
        err: failure,
        failurePhase: 'spawn',
        outcome: 'unknown',
        exitCode: null,
      },
    ]);
    expect(unknownSettleRecords()).toHaveLength(1);
    expect(probeLog.warn.mock.calls).toHaveLength(1);
  });

  test('an unknown outcome is recorded at warn level, unlike a routine not-found', async () => {
    const notFound = makeFakeChild();
    const notFoundProbe = runLoginShellProbe(
      () => notFound.child,
      '/bin/zsh',
      makeFakeTimers().timers,
      undefined,
      CODEX_PROBE_ARGS,
    );
    notFound.emitExit(1);
    await notFoundProbe;
    expect(unknownSettleRecords()).toHaveLength(0);

    const signalled = makeFakeChild();
    const signalledProbe = runLoginShellProbe(
      () => signalled.child,
      '/bin/zsh',
      makeFakeTimers().timers,
      undefined,
      CODEX_PROBE_ARGS,
    );
    signalled.emitExit(null);
    await signalledProbe;
    expect(unknownSettleRecords()).toHaveLength(1);
  });

  test('the where.exe probe settles under its own label, naming the binary it probed', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers } = makeFakeTimers();
    const probe = runWindowsPathProbe(
      () => child,
      'C:\\Windows\\System32\\where.exe',
      'claude',
      timers,
    );
    emitExit(0);
    expect(await probe).toBe(0);
    const [record] = settleRecords();
    expect(record).toEqual({
      label: 'where.exe',
      bin: 'claude',
      args: ['$PATH:claude'],
      outcome: 'present',
      exitCode: 0,
    });
  });
});
