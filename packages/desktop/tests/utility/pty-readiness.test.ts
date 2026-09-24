import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PtyProcessLike, PtySpawnOptions, SpawnPty } from '../../src/utility/pty-host.ts';
import {
  buildCwdFileProofCommand,
  createHarnessBudget,
  createPtyHostProbe,
  type EvaluatedInputOptions,
  type EvaluatedInputTiming,
  HARNESS_CHILD_KILL_WAIT_MS,
  HARNESS_VERDICT_POLL_INTERVAL_MS,
  HarnessBudgetRefusal,
  harnessTimeouts,
  type PtyStream,
  remainingGrantMs,
  resolveHarnessBudgetMs,
  type ShellReadyOptions,
  shellOutputBeyondAttach,
  type WaitOptions,
  waitForCondition,
  waitForEvaluatedInput,
  waitForShellReady,
} from '../support/pty-readiness.test-helper.ts';

interface FakeStream extends PtyStream {
  emit(chunk: string): void;
  fail(reason: string): void;
}

function createFakeStream(): FakeStream {
  let text = '';
  let failure: string | null = null;
  return {
    read: () => text,
    failure: () => failure,
    emit(chunk) {
      text += chunk;
    },
    fail(reason) {
      failure = reason;
    },
  };
}

const FAST_READY = { intervalMs: 5, quietSamples: 20, stallMs: 5_000 } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shell readiness gate', () => {
  test('does not report ready while the shell is still producing startup output', async () => {
    const stream = createFakeStream();
    stream.emit('\u001b[2J\u001b[H');
    const chunks = ['loading profile\r\n', 'startup notice\r\n', 'PS C:\\project> '];
    const timers = chunks.map((chunk, index) =>
      setTimeout(() => stream.emit(chunk), (index + 1) * 40),
    );
    try {
      await waitForShellReady(stream, 'shell ready', FAST_READY);
      expect(stream.read()).toContain('PS C:\\project> ');
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  });

  test('the quiet window is every sample the caller asked for, each separated by a real poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const quietSamples = 5;
    const intervalMs = 50;
    const stream = createFakeStream();
    stream.emit('PS C:\\project> ');
    const startedAt = performance.now();
    let elapsedMs = Number.NaN;
    const pending = waitForShellReady(stream, 'shell ready', { quietSamples, intervalMs }).then(
      () => {
        elapsedMs = performance.now() - startedAt;
      },
    );
    await vi.advanceTimersByTimeAsync((quietSamples + 2) * intervalMs);
    await pending;
    expect(elapsedMs).toBe(quietSamples * intervalMs);
  });

  test('reports ready once the stream settles instead of waiting out the budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    stream.emit('PS C:\\project> ');
    const startedAt = performance.now();
    let elapsedMs = Number.NaN;
    const pending = waitForShellReady(stream, 'shell ready', FAST_READY).then(() => {
      elapsedMs = performance.now() - startedAt;
    });
    await vi.advanceTimersByTimeAsync(FAST_READY.stallMs);
    await pending;
    expect(elapsedMs).toBeLessThan(FAST_READY.stallMs);
  });

  test('never reports a silent shell ready', async () => {
    const stream = createFakeStream();
    await expect(
      waitForShellReady(stream, 'shell ready', { intervalMs: 5, quietSamples: 3, stallMs: 120 }),
    ).rejects.toThrow(/shell ready/u);
  });

  test('surfaces a spawn failure that lands during startup', async () => {
    const stream = createFakeStream();
    stream.emit('\u001b[2J');
    const timer = setTimeout(() => stream.fail('spawn-error: File not found'), 20);
    try {
      await expect(waitForShellReady(stream, 'shell ready', FAST_READY)).rejects.toThrow(
        /File not found/u,
      );
    } finally {
      clearTimeout(timer);
    }
  });
});

describe('attach classifier direction', () => {
  const INTRODUCER = '\u001b]0;';

  test('a title the classifier cannot terminate stops withholding once a control byte follows', () => {
    const wedge = `${INTRODUCER}C:\\no\\terminator\r\nPowerShell 7.6.5`;
    expect(shellOutputBeyondAttach(wedge)).toBe('\r\nPowerShell 7.6.5');
  });

  test('a read cut inside a title is still attach, so the gate keeps waiting', () => {
    expect(shellOutputBeyondAttach(`${INTRODUCER}C:\\partial`)).toBe('');
    expect(shellOutputBeyondAttach('\u001b]')).toBe('');
    expect(shellOutputBeyondAttach('\u001b[?100')).toBe('');
  });

  test('a generic frame member as the shell own first output is consumed, not treated as speech', () => {
    expect(shellOutputBeyondAttach('\u001b[2Jcleared by a profile')).toBe('cleared by a profile');
    expect(shellOutputBeyondAttach('\u001b[2J')).toBe('');
  });
});

describe('harness budget override', () => {
  test('an override may narrow the declared budget but never widen it', () => {
    expect(resolveHarnessBudgetMs('1', 85_000)).toBe(1);
    expect(resolveHarnessBudgetMs('84999', 85_000)).toBe(84_999);
    expect(resolveHarnessBudgetMs('85001', 85_000)).toBe(85_000);
    expect(resolveHarnessBudgetMs('999999999', 85_000)).toBe(85_000);
  });

  test('an absent or empty override reads as unset and falls back to the declared budget', () => {
    for (const raw of [undefined, '']) {
      expect(resolveHarnessBudgetMs(raw, 85_000)).toBe(85_000);
    }
  });

  test('an override that is present but cannot bound the run is named instead of ignored', () => {
    for (const raw of ['soon', '0', '-1', 'NaN', 'Infinity']) {
      expect(() => resolveHarnessBudgetMs(raw, 85_000)).toThrow(
        /the OK_PTY_HARNESS_BUDGET_MS override for the harness budget must be a positive finite duration/u,
      );
    }
  });
});

describe('harness budget clock', () => {
  const FAKE_BUDGET_MS = 1_000;
  const FAKE_RESERVE_MS = 100;

  test('every later grant is strictly smaller than the one before it', () => {
    let nowMs = 0;
    const budget = createHarnessBudget(FAKE_BUDGET_MS, FAKE_RESERVE_MS, () => nowMs);
    const atStart = budget.grantMs('this scenario started');
    nowMs = FAKE_BUDGET_MS / 4;
    expect(budget.grantMs('this scenario started')).toBeLessThan(atStart);
  });

  test('a grant the reserve or the deadline has eaten is named in the harness wording, not as a bad argument', () => {
    let nowMs = 0;
    const budget = createHarnessBudget(FAKE_BUDGET_MS, FAKE_RESERVE_MS, () => nowMs);
    expect(budget.grantMs('this scenario started')).toBeGreaterThan(0);
    nowMs = FAKE_BUDGET_MS - FAKE_RESERVE_MS;
    expect(() => budget.grantMs('this scenario started')).toThrow(
      `the ${FAKE_BUDGET_MS}ms harness budget was spent before this scenario started`,
    );
    nowMs = FAKE_BUDGET_MS * 2;
    expect(() => budget.grantMs('this scenario started')).toThrow(
      `the ${FAKE_BUDGET_MS}ms harness budget was spent before this scenario started`,
    );
  });

  test('the default clock is the monotonic one the harness runs on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const wallNow = vi.spyOn(Date, 'now');
    const budget = createHarnessBudget(FAKE_BUDGET_MS, FAKE_RESERVE_MS);
    const atStart = budget.grantMs('this scenario started');
    await vi.advanceTimersByTimeAsync(FAKE_BUDGET_MS / 4);
    const afterAdvance = budget.grantMs('this scenario started');
    expect(wallNow).not.toHaveBeenCalled();
    expect(afterAdvance).toBeLessThan(atStart);
  });

  test('a budget or reserve that is not a positive finite duration is refused at construction', () => {
    expect(() => createHarnessBudget(Number.NaN, FAKE_RESERVE_MS)).toThrow(
      'the budget for the harness must be a positive finite duration in milliseconds, got NaN',
    );
    expect(() => createHarnessBudget(FAKE_BUDGET_MS, Number.POSITIVE_INFINITY)).toThrow(
      'the report reserve for the harness must be a positive finite duration in milliseconds, got Infinity',
    );
  });
});

describe('harness timeout ladder', () => {
  test('each rung leaves the one below it room to report its own verdict', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const ladder = harnessTimeouts(platform);
      expect(ladder.budgetMs).toBeGreaterThan(0);
      expect(ladder.verdictDeadlineMs).toBeGreaterThan(ladder.budgetMs);
      expect(ladder.testTimeoutMs).toBeGreaterThan(ladder.verdictDeadlineMs);
      expect(ladder.verdictDeadlineMs - ladder.budgetMs).toBeGreaterThan(
        HARNESS_VERDICT_POLL_INTERVAL_MS,
      );
      expect(ladder.testTimeoutMs - ladder.verdictDeadlineMs).toBeGreaterThan(
        HARNESS_CHILD_KILL_WAIT_MS,
      );
    }
  });

  test('windows gets the wider ladder its slower shell startup needs', () => {
    expect(harnessTimeouts('win32').budgetMs).toBeGreaterThan(harnessTimeouts('linux').budgetMs);
  });
});

describe('cwd file proof command', () => {
  test('reads a relative sentinel without embedding its random contents', () => {
    expect(buildCwdFileProofCommand('win32', '.ok-cwd-proof')).toBe(
      `Write-Output "CWD_PROOF=$(Get-Content -Raw -LiteralPath './.ok-cwd-proof')"`,
    );
    expect(buildCwdFileProofCommand('linux', '.ok-cwd-proof')).toBe(
      `printf 'CWD_PROOF=%s\\n' "$(cat './.ok-cwd-proof')"`,
    );
  });

  test('rejects a sentinel name that could inject shell syntax', () => {
    expect(() => buildCwdFileProofCommand('win32', "proof'; exit 1")).toThrow(
      /invalid cwd proof file name/u,
    );
  });
});

describe('condition waits', () => {
  test('uses the monotonic clock to enforce its timeout deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const wallNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const stream = createFakeStream();
    let outcome = 'pending';
    const pending = waitForCondition(stream, () => false, 'evaluated command output', {
      intervalMs: 5,
      stallMs: 10,
    }).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : String(error);
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(9);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatch(/timeout waiting for: evaluated command output/u);
    } finally {
      wallNow.mockReturnValue(1_010);
      await vi.advanceTimersByTimeAsync(5);
      await pending;
    }
  });

  test('surfaces a spawn failure instead of expiring as a timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    const stallMs = 3_000;
    setTimeout(() => stream.fail('spawn-error: posix_spawnp failed'), 20);
    const startedAt = performance.now();
    const settled = waitForCondition(stream, () => false, 'evaluated command output', {
      intervalMs: 5,
      stallMs,
    }).then(
      () => ({ message: 'resolved', elapsedMs: performance.now() - startedAt }),
      (error: unknown) => ({
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: performance.now() - startedAt,
      }),
    );
    await vi.advanceTimersByTimeAsync(stallMs);
    const { message, elapsedMs } = await settled;
    expect(message).toMatch(/posix_spawnp failed/u);
    expect(elapsedMs).toBeLessThan(stallMs);
  });

  test('surfaces an early exit instead of expiring as a timeout', async () => {
    const stream = createFakeStream();
    const timer = setTimeout(() => stream.fail('exited (code 1, signal none)'), 20);
    try {
      await expect(
        waitForCondition(stream, () => false, 'evaluated command output', {
          intervalMs: 5,
          stallMs: 3_000,
        }),
      ).rejects.toThrow(/exited \(code 1/u);
    } finally {
      clearTimeout(timer);
    }
  });

  test('reads an awaited exit as success rather than as a failure', async () => {
    const stream = createFakeStream();
    stream.fail('exited (code 1, signal none)');
    await expect(
      waitForCondition(stream, () => true, 'failure for unspawnable shell', {
        intervalMs: 5,
        stallMs: 200,
      }),
    ).resolves.toBeUndefined();
  });

  test('a poll interval that cannot pace the wait is named instead of looped on', async () => {
    const stream = createFakeStream();
    for (const intervalMs of [Number.NaN, 0, -1]) {
      await expect(
        waitForCondition(stream, () => false, 'evaluated command output', {
          intervalMs,
          stallMs: 60,
        }),
      ).rejects.toThrow(
        /the poll interval for evaluated command output must be a positive finite duration/u,
      );
      await expect(
        waitForShellReady(stream, 'evaluated command output', { intervalMs, stallMs: 60 }),
      ).rejects.toThrow(
        /the poll interval for evaluated command output must be a positive finite duration/u,
      );
    }
  });

  test('a stall window that cannot bound the wait is named instead of polled against', async () => {
    const stream = createFakeStream();
    for (const stallMs of [Number.NaN, 0, -1]) {
      await expect(
        waitForCondition(stream, () => false, 'evaluated command output', {
          stallMs,
          intervalMs: 5,
        }),
      ).rejects.toThrow(
        /the stall window for evaluated command output must be a positive finite duration/u,
      );
    }
  });

  test('names what did arrive when a condition times out', async () => {
    const stream = createFakeStream();
    stream.emit('PS C:\\project> Write-Output "HARNESS_$((6*7))_DONE"');
    await expect(
      waitForCondition(stream, () => false, 'evaluated command output', {
        intervalMs: 5,
        stallMs: 60,
      }),
    ).rejects.toThrow(/HARNESS_/u);
  });
});

function evaluateFakePowerShellCommand(command: string): string | null {
  const arithmetic = /^Write-Output "([^"]*)_\$\(\((\d+)\*(\d+)\)\)_([^"]*)"$/u.exec(command);
  if (arithmetic !== null) {
    return `${arithmetic[1]}_${Number(arithmetic[2]) * Number(arithmetic[3])}_${arithmetic[4]}`;
  }
  return /^Write-Output "([^"]*)"$/u.exec(command)?.[1] ?? null;
}

function createStartupRaceSpawn(readyAfterMs: number): SpawnPty {
  return (_file: string, _args: string[] | string, _options: PtySpawnOptions): PtyProcessLike => {
    let emit: (data: string) => void = () => undefined;
    let accepting = false;
    const timers = [
      setTimeout(() => emit('loading profile\r\n'), readyAfterMs / 2),
      setTimeout(() => {
        accepting = true;
        emit('PS C:\\project> ');
      }, readyAfterMs),
    ];
    queueMicrotask(() => emit('\u001b[2J\u001b[H'));
    return {
      pid: 4242,
      onData(listener) {
        emit = listener;
      },
      onExit() {},
      write(data) {
        if (!accepting) return;
        const typed = data.replace(/\r$/u, '');
        emit(`${typed}\r\n`);
        const output = evaluateFakePowerShellCommand(typed);
        if (output === null) return;
        timers.push(setTimeout(() => emit(`${output}\r\n`), 0));
      },
      resize() {},
      kill() {
        for (const timer of timers) clearTimeout(timer);
      },
      pause() {},
      resume() {},
    };
  };
}

describe('driving a real host through a shell that starts slowly', () => {
  test('the command lands because the drive waits for the read loop', async () => {
    const host = createPtyHostProbe({
      spawn: createStartupRaceSpawn(60),
      env: { PATH: '/usr/bin', SHELL: '/bin/sh' },
      platform: 'linux',
      shellExists: () => true,
    });
    const io = host.streamOf('io');
    try {
      host.send({ type: 'create', ptyId: 'io', cwd: '/tmp', cols: 80, rows: 24 });
      await waitForShellReady(io, 'interactive shell ready', FAST_READY);
      host.send({
        type: 'input',
        ptyId: 'io',
        data: 'Write-Output "HARNESS_$((6*7))_DONE"\r',
      });
      await waitForCondition(io, () => io.read().includes('HARNESS_42_DONE'), 'command output', {
        intervalMs: 5,
        stallMs: 2_000,
      });
    } finally {
      host.killActive();
    }
  });

  test('maps a real host spawn failure into the readiness failure channel', async () => {
    const host = createPtyHostProbe({
      spawn: () => {
        throw new Error('EMFILE: too many open files');
      },
      env: { PATH: '/usr/bin', SHELL: '/bin/sh' },
      platform: 'linux',
      shellExists: () => true,
    });
    const io = host.streamOf('io');
    try {
      host.send({ type: 'create', ptyId: 'io', cwd: '/tmp', cols: 80, rows: 24 });
      await expect(
        waitForCondition(io, () => false, 'shell ready', { intervalMs: 5, stallMs: 100 }),
      ).rejects.toThrow(/shell failed before shell ready: spawn-error: EMFILE/u);
    } finally {
      host.killActive();
    }
  });

  test('maps a real host exit into the readiness failure channel', async () => {
    const spawn: SpawnPty = () => ({
      pid: 4243,
      onData() {},
      onExit(listener) {
        queueMicrotask(() => listener({ exitCode: 3, signal: undefined }));
      },
      write() {},
      resize() {},
      kill() {},
      pause() {},
      resume() {},
    });
    const host = createPtyHostProbe({
      spawn,
      env: { PATH: '/usr/bin', SHELL: '/bin/sh' },
      platform: 'linux',
      shellExists: () => true,
    });
    const io = host.streamOf('io');
    try {
      host.send({ type: 'create', ptyId: 'io', cwd: '/tmp', cols: 80, rows: 24 });
      await expect(
        waitForCondition(io, () => false, 'shell ready', { intervalMs: 5, stallMs: 100 }),
      ).rejects.toThrow(/shell failed before shell ready: exited \(code 3, signal none\)/u);
    } finally {
      host.killActive();
    }
  });

  test('warnings the host raises reach a logger handed to the probe, so a run can say which ConPTY it used', () => {
    const warnings: Record<string, unknown>[] = [];
    const attempts: PtySpawnOptions[] = [];
    const raceSpawn = createStartupRaceSpawn(0);
    const host = createPtyHostProbe({
      spawn: (file, args, options) => {
        attempts.push(options);
        if (attempts.length === 1) throw new Error('Cannot find conpty.dll beside conpty.node');
        return raceSpawn(file, args, options);
      },
      env: { SystemRoot: 'C:\\Windows' },
      platform: 'win32',
      shellExists: () => true,
      logger: { warn: (entry) => warnings.push(entry) },
    });
    try {
      host.send({
        type: 'create',
        ptyId: 'io',
        cwd: 'C:\\project',
        cols: 80,
        rows: 24,
        shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      });
      expect(attempts.map((options) => options.useConptyDll)).toEqual([true, false]);
      expect(warnings).toContainEqual(
        expect.objectContaining({ event: 'pty-host-conpty-dll-fallback' }),
      );
    } finally {
      host.killActive();
    }
  });
});

const INPUT_READY_MARKER = 'OK_INPUT_READY_deadbeef_42_READY';
const INPUT_READY_PROBE = {
  input: 'Write-Output "OK_INPUT_READY_deadbeef_$((6*7))_READY"\r',
  marker: INPUT_READY_MARKER,
} as const;
const INPUT_READY_FAST = { roundTripStallMs: 200, intervalMs: 5 } as const;
const BOOTED_PROMPT = 'PS C:\\project> ';
const SLOW_EVALUATION_MS = 120;
const READINESS_CEILING_MS = 16_000;
const SILENT_SHELL_VERDICT = 'without new shell output, the only progress signal this wait watches';

function driveEvaluatingShell(
  stream: FakeStream,
  options: { evaluatesAfterMs?: number; evaluates?: boolean } = {},
): { sent: string[]; send: (data: string) => void; dispose: () => void } {
  const sent: string[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  return {
    sent,
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
    },
    send: (data) => {
      sent.push(data);
      if (options.evaluates === false) return;
      const typed = data.replace(/\r$/u, '');
      const output = evaluateFakePowerShellCommand(typed);
      if (output === null) return;
      timers.push(
        setTimeout(() => stream.emit(`${typed}\r\n${output}\r\n`), options.evaluatesAfterMs ?? 0),
      );
    },
  };
}

describe('evaluated-input readiness', () => {
  test('returns the monotonic clock elapsed delta for a single evaluated probe', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const stream = createFakeStream();
    stream.emit(BOOTED_PROMPT);
    const shell = driveEvaluatingShell(stream, { evaluatesAfterMs: SLOW_EVALUATION_MS });
    try {
      const pending = waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
        roundTripStallMs: 5_000,
        intervalMs: 5,
        budgetMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(SLOW_EVALUATION_MS);
      expect((await pending).roundTripMs).toBe(SLOW_EVALUATION_MS);
      expect(shell.sent).toEqual([INPUT_READY_PROBE.input]);
    } finally {
      shell.dispose();
    }
  });

  test('a booted shell gone silent is refused after its 16 second silence window, not at a round-trip ceiling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    stream.emit(BOOTED_PROMPT);
    const shell = driveEvaluatingShell(stream, { evaluates: false });
    let outcome: string = 'pending';
    const pending = waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
      budgetMs: READINESS_CEILING_MS * 4,
    }).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : String(error);
      },
    );
    await vi.advanceTimersByTimeAsync(READINESS_CEILING_MS - 1_000);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(outcome).toBe(
      `timeout waiting for: input ready after ${READINESS_CEILING_MS}ms ${SILENT_SHELL_VERDICT} (received ${JSON.stringify(BOOTED_PROMPT)})`,
    );
    await pending;
  });

  test('a shell that only echoes the probe never reports ready', async () => {
    const stream = createFakeStream();
    stream.emit(BOOTED_PROMPT);
    await expect(
      waitForEvaluatedInput(stream, (data) => stream.emit(data), INPUT_READY_PROBE, 'input ready', {
        ...INPUT_READY_FAST,
        budgetMs: 5_000,
      }),
    ).rejects.toThrow(/timeout waiting for: input ready/u);
    expect(stream.read()).toContain('Write-Output');
    expect(stream.read()).not.toContain(INPUT_READY_MARKER);
  });

  test('a shell that never evaluates times out having written the probe once', async () => {
    const stream = createFakeStream();
    stream.emit(BOOTED_PROMPT);
    const shell = driveEvaluatingShell(stream, { evaluates: false });
    await expect(
      waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
        ...INPUT_READY_FAST,
        budgetMs: 5_000,
      }),
    ).rejects.toThrow(/timeout waiting for: input ready/u);
    expect(shell.sent).toEqual([INPUT_READY_PROBE.input]);
  });

  test('rejects a probe whose own echo would satisfy it', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream);
    await expect(
      waitForEvaluatedInput(
        stream,
        shell.send,
        { ...INPUT_READY_PROBE, input: `echo ${INPUT_READY_MARKER}` },
        'input ready',
        { ...INPUT_READY_FAST, budgetMs: 5_000 },
      ),
    ).rejects.toThrow(/must not contain its marker/u);
    expect(shell.sent).toEqual([]);
  });

  test('a dead shell short-circuits instead of waiting out the budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { evaluates: false });
    stream.fail('exited (code 1, signal none)');
    const budgetMs = 5_000;
    const { verdict, settled } = watchEvaluatedInput(stream, shell.send, {
      roundTripStallMs: 5_000,
      intervalMs: 5,
      budgetMs,
    });
    await vi.advanceTimersByTimeAsync(budgetMs);
    await settled;
    expect(verdict.settled).toBe('failed');
    expect(verdict.message).toMatch(
      /shell died before producing output for input ready, probe unwritten/u,
    );
    expect(verdict.atMs).toBeLessThan(budgetMs);
    expect(shell.sent).toEqual([]);
  });
});

const ATTACH_PROLOGUE = '\u001b[?9001h\u001b[?1004h';
const SHIPPED_ATTACH_PROLOGUE = '\u001b[c\u001b[?1004h\u001b[?9001h';
const BOOT_PAST_ROUND_TRIP_MS = READINESS_CEILING_MS + 500;
const CONPTY_REPAINT = '\u001b[?25l\u001b[2J\u001b[m\u001b[H';
const CONPTY_SHOW_CURSOR = '\u001b[?25h';
const WINDOWS_POWERSHELL_TITLE_BEL =
  '\u001b]0;Administrator: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007';
const WINDOWS_POWERSHELL_TITLE_ST =
  '\u001b]0;Administrator: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u001b\\';
const CONPTY_INIT_FRAME = `${CONPTY_REPAINT}${WINDOWS_POWERSHELL_TITLE_BEL}${CONPTY_SHOW_CURSOR}`;
const CONPTY_INIT_FRAME_ST_TITLE = `${CONPTY_REPAINT}${WINDOWS_POWERSHELL_TITLE_ST}${CONPTY_SHOW_CURSOR}`;
const CONPTY_INIT_FRAME_CUT_MID_TITLE = `${CONPTY_REPAINT}\u001b]0;C:\\Prog`;
const WINDOWS_POWERSHELL_GUID_ECHO = '7768de99-595e-40d4-9a3d-a4760b05683b\r\n';
const PWSH_BANNER = 'PowerShell 7.6.5\r\n';
const PWSH_TITLE = '\u001b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\u0007';
const PWSH_ADMIN_TITLE = '\u001b]0;Administrator: C:\\Program Files\\PowerShell\\7\\pwsh.exe\u0007';
const CI_CAPTURE_CONTENT_FREE_FRAME = `${CONPTY_INIT_FRAME}${WINDOWS_POWERSHELL_GUID_ECHO}`;
const CI_CAPTURE_BANNER_INSIDE_FRAME = `${CONPTY_REPAINT}${PWSH_BANNER}${PWSH_TITLE}${CONPTY_SHOW_CURSOR}`;
const CI_CAPTURE_BANNER_THEN_RETITLE = `${CI_CAPTURE_BANNER_INSIDE_FRAME}${PWSH_ADMIN_TITLE}`;

describe('shell startup is a liveness wait, not a round-trip budget', () => {
  test('a shell whose first output arrives after the round-trip ceiling still reports ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    stream.emit(ATTACH_PROLOGUE);
    const shell = driveEvaluatingShell(stream);
    const boot = setTimeout(() => stream.emit(BOOTED_PROMPT), BOOT_PAST_ROUND_TRIP_MS);
    let outcome: string = 'pending';
    const pending = waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
      budgetMs: BOOT_PAST_ROUND_TRIP_MS * 4,
    }).then(
      (result): EvaluatedInputTiming | null => {
        outcome = 'resolved';
        return result;
      },
      (error: unknown): EvaluatedInputTiming | null => {
        outcome = error instanceof Error ? error.message : String(error);
        return null;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(READINESS_CEILING_MS);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(BOOT_PAST_ROUND_TRIP_MS - READINESS_CEILING_MS + 100);
      expect(outcome).toBe('resolved');
      const timing = await pending;
      if (timing === null) throw new Error('the wait resolved without reporting any timing');
      expect(timing.firstOutputMs).toBeGreaterThanOrEqual(BOOT_PAST_ROUND_TRIP_MS);
      expect(timing.firstOutput).toContain('PS C:');
      expect(shell.sent).toEqual([INPUT_READY_PROBE.input]);
    } finally {
      clearTimeout(boot);
      shell.dispose();
      await pending;
    }
  });

  test('a shell that never writes is named as never having produced output', async () => {
    const stream = createFakeStream();
    stream.emit(ATTACH_PROLOGUE);
    const shell = driveEvaluatingShell(stream);
    try {
      const failure = await waitForEvaluatedInput(
        stream,
        shell.send,
        INPUT_READY_PROBE,
        'input ready',
        { budgetMs: 150, intervalMs: 5 },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(HarnessBudgetRefusal);
      expect((failure as Error).message).toMatch(/shell never produced output before input ready/u);
      expect(shell.sent).toEqual([]);
    } finally {
      shell.dispose();
    }
  });

  test('a shell that boots but never answers is named at the round trip, not at startup', async () => {
    const stream = createFakeStream();
    stream.emit(`${ATTACH_PROLOGUE}${BOOTED_PROMPT}`);
    const shell = driveEvaluatingShell(stream, { evaluates: false });
    try {
      await expect(
        waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
          budgetMs: 5_000,
          roundTripStallMs: 200,
          intervalMs: 5,
        }),
      ).rejects.toThrow(/timeout waiting for: input ready/u);
      expect(shell.sent).toEqual([INPUT_READY_PROBE.input]);
    } finally {
      shell.dispose();
    }
  });

  test('the attach handshake alone is not the shell speaking, and one byte past it is', () => {
    expect(shellOutputBeyondAttach(ATTACH_PROLOGUE)).toBe('');
    expect(shellOutputBeyondAttach(`${ATTACH_PROLOGUE}${BOOTED_PROMPT}`)).toBe(BOOTED_PROMPT);
    expect(shellOutputBeyondAttach(ATTACH_PROLOGUE.slice(0, -2))).toBe('');
    expect(shellOutputBeyondAttach('')).toBe('');
  });

  test('the order the bundled ConPTY ships is not the shell speaking either', () => {
    expect(shellOutputBeyondAttach(SHIPPED_ATTACH_PROLOGUE)).toBe('');
    expect(shellOutputBeyondAttach(`${SHIPPED_ATTACH_PROLOGUE}${BOOTED_PROMPT}`)).toBe(
      BOOTED_PROMPT,
    );
    expect(shellOutputBeyondAttach(SHIPPED_ATTACH_PROLOGUE.slice(0, -2))).toBe('');
  });

  test("the host's screen-init frame on attach is not the shell speaking", () => {
    expect(shellOutputBeyondAttach(CONPTY_INIT_FRAME)).toBe('');
    expect(shellOutputBeyondAttach(`${ATTACH_PROLOGUE}${CONPTY_INIT_FRAME}`)).toBe('');
    expect(shellOutputBeyondAttach(`${SHIPPED_ATTACH_PROLOGUE}${CONPTY_INIT_FRAME}`)).toBe('');
    expect(shellOutputBeyondAttach(`${ATTACH_PROLOGUE}${CONPTY_INIT_FRAME_ST_TITLE}`)).toBe('');
    expect(shellOutputBeyondAttach(`${ATTACH_PROLOGUE}${CONPTY_INIT_FRAME_CUT_MID_TITLE}`)).toBe(
      '',
    );
  });

  test('a Windows capture reduces to the bytes the shell itself wrote', () => {
    expect(
      shellOutputBeyondAttach(`${SHIPPED_ATTACH_PROLOGUE}${CI_CAPTURE_CONTENT_FREE_FRAME}`),
    ).toBe(WINDOWS_POWERSHELL_GUID_ECHO);
    expect(
      shellOutputBeyondAttach(`${SHIPPED_ATTACH_PROLOGUE}${CI_CAPTURE_BANNER_INSIDE_FRAME}`),
    ).toBe(`${PWSH_BANNER}${PWSH_TITLE}${CONPTY_SHOW_CURSOR}`);
    expect(shellOutputBeyondAttach(`${ATTACH_PROLOGUE}${CI_CAPTURE_BANNER_THEN_RETITLE}`)).toBe(
      `${PWSH_BANNER}${PWSH_TITLE}${CONPTY_SHOW_CURSOR}${PWSH_ADMIN_TITLE}`,
    );
    expect(
      shellOutputBeyondAttach(`${ATTACH_PROLOGUE}${CONPTY_INIT_FRAME_ST_TITLE}${BOOTED_PROMPT}`),
    ).toBe(BOOTED_PROMPT);
  });

  test('shell output behind the init frame is never stripped with it', () => {
    expect(
      shellOutputBeyondAttach(`${ATTACH_PROLOGUE}${CONPTY_INIT_FRAME}${BOOTED_PROMPT}`),
    ).toContain(BOOTED_PROMPT);
    expect(shellOutputBeyondAttach(CI_CAPTURE_BANNER_INSIDE_FRAME)).toContain('PowerShell 7.6.5');
    expect(shellOutputBeyondAttach(CI_CAPTURE_CONTENT_FREE_FRAME)).toContain(
      WINDOWS_POWERSHELL_GUID_ECHO,
    );
    expect(
      shellOutputBeyondAttach(`${ATTACH_PROLOGUE}${CONPTY_INIT_FRAME_ST_TITLE}${BOOTED_PROMPT}`),
    ).toContain(BOOTED_PROMPT);
  });

  test('the first output the gate reports leads with the bytes that opened it', async () => {
    const stream = createFakeStream();
    const head = 'OK_GATE_OPENED_HERE';
    stream.emit(
      `${SHIPPED_ATTACH_PROLOGUE}${CONPTY_INIT_FRAME}${head}${'x'.repeat(600)}${BOOTED_PROMPT}`,
    );
    const shell = driveEvaluatingShell(stream);
    try {
      const timing = await waitForEvaluatedInput(
        stream,
        shell.send,
        INPUT_READY_PROBE,
        'input ready',
        { budgetMs: 5_000, roundTripStallMs: 2_000, intervalMs: 5 },
      );
      expect(timing.firstOutput).toContain(head);
      expect(timing.firstOutput.startsWith('...')).toBe(false);
    } finally {
      shell.dispose();
    }
  });

  test('the shipped attach burst leaves the gate shut, and a prompt behind it opens it', async () => {
    const attaching = createFakeStream();
    attaching.emit(SHIPPED_ATTACH_PROLOGUE);
    const attachingShell = driveEvaluatingShell(attaching);
    const booted = createFakeStream();
    booted.emit(`${SHIPPED_ATTACH_PROLOGUE}${BOOTED_PROMPT}`);
    const bootedShell = driveEvaluatingShell(booted);
    try {
      await expect(
        waitForEvaluatedInput(attaching, attachingShell.send, INPUT_READY_PROBE, 'input ready', {
          budgetMs: 150,
          intervalMs: 5,
        }),
      ).rejects.toThrow(/shell never produced output before input ready/u);
      expect(attachingShell.sent).toEqual([]);

      const timing = await waitForEvaluatedInput(
        booted,
        bootedShell.send,
        INPUT_READY_PROBE,
        'input ready',
        { budgetMs: 5_000, roundTripStallMs: 2_000, intervalMs: 5 },
      );
      expect(timing.firstOutput).toContain('PS C:');
      expect(bootedShell.sent).toEqual([INPUT_READY_PROBE.input]);
    } finally {
      attachingShell.dispose();
      bootedShell.dispose();
    }
  });

  test('a handshake cut by a read boundary does not open the gate', async () => {
    const stream = createFakeStream();
    stream.emit(ATTACH_PROLOGUE.slice(0, -2));
    const shell = driveEvaluatingShell(stream);
    try {
      await expect(
        waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
          budgetMs: 150,
          intervalMs: 5,
        }),
      ).rejects.toThrow(/shell never produced output before input ready/u);
      expect(shell.sent).toEqual([]);
    } finally {
      shell.dispose();
    }
  });

  test('a budget that cannot bound the wait is named instead of polled against', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream);
    try {
      await expect(
        waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
          intervalMs: 5,
        } as unknown as EvaluatedInputOptions),
      ).rejects.toThrow(/budget for input ready must be a positive finite duration/u);
      for (const budgetMs of [Number.NaN, 0, -1]) {
        await expect(
          waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
            budgetMs,
            intervalMs: 5,
          }),
        ).rejects.toThrow(/budget for input ready must be a positive finite duration/u);
      }
      await expect(
        waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
          budgetMs: 5_000,
          roundTripStallMs: Number.NaN,
          intervalMs: 5,
        }),
      ).rejects.toThrow(
        /the round-trip stall window for input ready must be a positive finite duration/u,
      );
      expect(shell.sent).toEqual([]);
    } finally {
      shell.dispose();
    }
  });

  test('a late-booting shell leaves the round trip only what the budget has left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    stream.emit(ATTACH_PROLOGUE);
    const shell = driveEvaluatingShell(stream, { evaluates: false });
    const boot = setTimeout(() => stream.emit(BOOTED_PROMPT), BOOT_PAST_ROUND_TRIP_MS);
    let outcome: string = 'pending';
    const pending = waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
      budgetMs: BOOT_PAST_ROUND_TRIP_MS + 1_000,
    }).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : String(error);
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(BOOT_PAST_ROUND_TRIP_MS);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1_100);
      expect(outcome).toMatch(/^timeout waiting for: input ready after 1000ms/u);
      await pending;
    } finally {
      clearTimeout(boot);
      shell.dispose();
    }
  });

  test('startup that outruns its grant is refused as a spent budget, with the probe unsent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    stream.emit(ATTACH_PROLOGUE);
    const shell = driveEvaluatingShell(stream);
    const boot = setTimeout(() => stream.emit(BOOTED_PROMPT), 25);
    let outcome: unknown = 'pending';
    const pending = waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
      budgetMs: 20,
      intervalMs: 15,
    }).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(40);
      expect(outcome).toBeInstanceOf(HarnessBudgetRefusal);
      expect((outcome as Error).message).toMatch(
        /^the 20ms grant for input ready was spent before the round trip could start/u,
      );
      expect(shell.sent).toEqual([]);
      await pending;
    } finally {
      clearTimeout(boot);
      shell.dispose();
    }
  });

  test('the startup timeout tells a silent PTY apart from one that only handshook', async () => {
    const silent = createFakeStream();
    const handshaken = createFakeStream();
    handshaken.emit(ATTACH_PROLOGUE);
    const budget = { budgetMs: 60, intervalMs: 5 } as const;
    const cases = [
      { stream: silent, tail: 'received nothing' },
      { stream: handshaken, tail: `received ${JSON.stringify(ATTACH_PROLOGUE)}` },
    ];
    for (const { stream, tail } of cases) {
      const failure = await waitForEvaluatedInput(
        stream,
        () => undefined,
        INPUT_READY_PROBE,
        'input ready',
        budget,
      ).then(
        () => null,
        (error: unknown) => (error as Error).message,
      );
      expect(failure).toContain('shell never produced output before input ready');
      expect(failure).toContain(tail);
    }
  });

  test('a shell that dies during startup is surfaced without writing the probe into it', async () => {
    const stream = createFakeStream();
    stream.emit(ATTACH_PROLOGUE);
    const shell = driveEvaluatingShell(stream);
    stream.fail('exited (code -1, signal none)');
    try {
      await expect(
        waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
          budgetMs: 5_000,
          intervalMs: 5,
        }),
      ).rejects.toThrow(
        /shell died before producing output for input ready, probe unwritten: exited \(code -1/u,
      );
      expect(shell.sent).toEqual([]);
    } finally {
      shell.dispose();
    }
  });
});

const FIRST_OUTPUT_AT_MS = READINESS_CEILING_MS / 40;
const MARKER_PAST_CEILING_AT_MS = READINESS_CEILING_MS + READINESS_CEILING_MS / 8;
const ADVANCEMENT_BUDGET_MS = READINESS_CEILING_MS * 2;
const ADVANCEMENT_POLL_MS = 100;
const IDENTICAL_TAIL_CHARS = 1_024;
const CI_BOOT_CAPTURE = `${CI_CAPTURE_BANNER_THEN_RETITLE}${BOOTED_PROMPT}`;
const REPEATED_BOOT_BLOCK = CI_BOOT_CAPTURE.repeat(
  Math.ceil(IDENTICAL_TAIL_CHARS / CI_BOOT_CAPTURE.length),
);

interface OracleVerdict {
  settled: 'pending' | 'ready' | 'failed';
  atMs: number;
  message: string;
  tail: string;
  timing: EvaluatedInputTiming | null;
}

function scheduleEmissions(
  stream: FakeStream,
  steps: ReadonlyArray<{ atMs: number; chunk: string }>,
): () => void {
  const timers = steps.map((step) => setTimeout(() => stream.emit(step.chunk), step.atMs));
  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}

function watchEvaluatedInput(
  stream: FakeStream,
  send: (data: string) => void,
  options: EvaluatedInputOptions,
): { verdict: OracleVerdict; settled: Promise<void> } {
  const startedAt = performance.now();
  const verdict: OracleVerdict = {
    settled: 'pending',
    atMs: Number.NaN,
    message: '',
    tail: '',
    timing: null,
  };
  const record = (): void => {
    verdict.atMs = performance.now() - startedAt;
    verdict.tail = stream.read().slice(-IDENTICAL_TAIL_CHARS);
  };
  const settled = waitForEvaluatedInput(
    stream,
    send,
    INPUT_READY_PROBE,
    'input ready',
    options,
  ).then(
    (timing) => {
      verdict.settled = 'ready';
      verdict.timing = timing;
      record();
    },
    (error: unknown) => {
      verdict.settled = 'failed';
      verdict.message = error instanceof Error ? error.message : String(error);
      record();
    },
  );
  return { verdict, settled };
}

async function raceWedgedAgainstAdvancing(): Promise<{
  wedged: OracleVerdict;
  advancing: OracleVerdict;
}> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const wedgedStream = createFakeStream();
  const advancingStream = createFakeStream();
  wedgedStream.emit(ATTACH_PROLOGUE);
  advancingStream.emit(ATTACH_PROLOGUE);
  const wedgedShell = driveEvaluatingShell(wedgedStream, { evaluates: false });
  const advancingShell = driveEvaluatingShell(advancingStream, { evaluates: false });
  const boot = [{ atMs: FIRST_OUTPUT_AT_MS, chunk: REPEATED_BOOT_BLOCK }];
  const advances = [...boot];
  for (
    let atMs = FIRST_OUTPUT_AT_MS + ADVANCEMENT_POLL_MS;
    atMs <= ADVANCEMENT_BUDGET_MS;
    atMs += ADVANCEMENT_POLL_MS
  ) {
    advances.push({ atMs, chunk: REPEATED_BOOT_BLOCK });
  }
  const stopWedged = scheduleEmissions(wedgedStream, boot);
  const stopAdvancing = scheduleEmissions(advancingStream, advances);
  const waitOptions = {
    budgetMs: ADVANCEMENT_BUDGET_MS,
    intervalMs: ADVANCEMENT_POLL_MS,
  } as const;
  const wedged = watchEvaluatedInput(wedgedStream, wedgedShell.send, waitOptions);
  const advancing = watchEvaluatedInput(advancingStream, advancingShell.send, waitOptions);
  try {
    await vi.advanceTimersByTimeAsync(ADVANCEMENT_BUDGET_MS + ADVANCEMENT_POLL_MS);
    return { wedged: wedged.verdict, advancing: advancing.verdict };
  } finally {
    stopWedged();
    stopAdvancing();
    wedgedShell.dispose();
    advancingShell.dispose();
    await Promise.all([wedged.settled, advancing.settled]);
  }
}

describe('readiness is refused for lack of progress, not for elapsed time while advancing', () => {
  test('a shell still advancing when the ceiling passes is ready once its marker lands inside the budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    stream.emit(ATTACH_PROLOGUE);
    const shell = driveEvaluatingShell(stream, { evaluates: false });
    const stopEmitting = scheduleEmissions(stream, [
      { atMs: FIRST_OUTPUT_AT_MS, chunk: CI_CAPTURE_BANNER_INSIDE_FRAME },
      { atMs: READINESS_CEILING_MS / 4, chunk: PWSH_ADMIN_TITLE },
      { atMs: READINESS_CEILING_MS / 2, chunk: BOOTED_PROMPT },
      { atMs: (READINESS_CEILING_MS * 7) / 8, chunk: `${INPUT_READY_PROBE.input}\n` },
      { atMs: MARKER_PAST_CEILING_AT_MS, chunk: `${INPUT_READY_MARKER}\r\n` },
    ]);
    const { verdict, settled } = watchEvaluatedInput(stream, shell.send, {
      budgetMs: ADVANCEMENT_BUDGET_MS,
      intervalMs: ADVANCEMENT_POLL_MS,
    });
    try {
      await vi.advanceTimersByTimeAsync(MARKER_PAST_CEILING_AT_MS + ADVANCEMENT_POLL_MS);
      expect({ settled: verdict.settled, failure: verdict.message }).toEqual({
        settled: 'ready',
        failure: '',
      });
      expect(verdict.atMs).toBeLessThan(ADVANCEMENT_BUDGET_MS);
      const timing = verdict.timing;
      if (timing === null) throw new Error('the wait reported ready without reporting any timing');
      expect(timing.roundTripMs).toBeGreaterThan(READINESS_CEILING_MS);
      expect(shell.sent).toEqual([INPUT_READY_PROBE.input]);
    } finally {
      stopEmitting();
      shell.dispose();
      await settled;
    }
  });

  test('a wedged shell is refused sooner than one that is still advancing, and both are refused', async () => {
    const { wedged, advancing } = await raceWedgedAgainstAdvancing();
    expect(wedged.settled).toBe('failed');
    expect(advancing.settled).toBe('failed');
    expect(wedged.atMs).toBeLessThan(ADVANCEMENT_BUDGET_MS);
    expect(wedged.atMs).toBeLessThan(advancing.atMs);
  });

  test('a wedged shell and an advancing one showing the reader the same bytes are not refused alike', async () => {
    const { wedged, advancing } = await raceWedgedAgainstAdvancing();
    expect(wedged.tail).toBe(advancing.tail);
    expect(wedged.message).not.toBe(advancing.message);
  });
});

const SCENARIO_BUDGET_MS = 1_000;
const SCENARIO_RESERVE_MS = 100;

function grantOutcome(
  budget: ReturnType<typeof createHarnessBudget>,
  before: string,
): 'granted' | 'refused' {
  try {
    budget.grantMs(before);
    return 'granted';
  } catch {
    return 'refused';
  }
}

function thrownFrom(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('the call under test was expected to throw and did not');
}

function verdictShapeOf(error: Error): string {
  return `${error.constructor.name}|${Object.keys(error).sort().join(',')}`;
}

describe('the harness budget bounds each scenario, not only the run', () => {
  test('no single scenario is granted everything the budget has left', () => {
    const budget = createHarnessBudget(SCENARIO_BUDGET_MS, SCENARIO_RESERVE_MS, () => 0);
    expect(budget.grantMs('the first scenario started')).toBeLessThan(
      SCENARIO_BUDGET_MS - SCENARIO_RESERVE_MS,
    );
  });

  test('a scenario that spends its whole grant leaves the scenarios behind it able to run', () => {
    let nowMs = 0;
    const budget = createHarnessBudget(SCENARIO_BUDGET_MS, SCENARIO_RESERVE_MS, () => nowMs);
    nowMs += budget.grantMs('the first scenario started');
    expect(grantOutcome(budget, 'the second scenario started')).toBe('granted');
  });

  test('a remainder one poll can act on is granted, and anything under one poll is a spent grant', () => {
    const deadlineAt = SCENARIO_BUDGET_MS;
    const pollMs = 20;
    expect(
      remainingGrantMs(deadlineAt, 'a wait inside the scenario', {
        minimumMs: pollMs,
        now: () => deadlineAt - pollMs,
      }),
    ).toBe(pollMs);
    for (const remaining of [pollMs - 1, 1, 0, -1, Number.NaN]) {
      const spent = thrownFrom(() =>
        remainingGrantMs(deadlineAt, 'a wait inside the scenario', {
          minimumMs: pollMs,
          now: () => deadlineAt - remaining,
        }),
      );
      expect(spent).toBeInstanceOf(HarnessBudgetRefusal);
      expect(spent.message).toContain('a wait inside the scenario');
      expect(spent.message).not.toContain('must be a positive finite duration');
    }
  });

  test('refusing to start a scenario is not the verdict a scenario that ran and failed carries', () => {
    let nowMs = 0;
    const budget = createHarnessBudget(SCENARIO_BUDGET_MS, SCENARIO_RESERVE_MS, () => nowMs);
    nowMs = SCENARIO_BUDGET_MS;
    const refusal = thrownFrom(() => budget.grantMs('the second scenario started'));
    const ranAndFailed = new Error(refusal.message);
    expect(verdictShapeOf(refusal)).not.toBe(verdictShapeOf(ranAndFailed));
  });
});

const CONTAINED_WAIT_WINDOW_MS = READINESS_CEILING_MS / 8;
const CONTAINED_WAIT_CONTAINMENT_MS = READINESS_CEILING_MS;
const CONTAINED_WAIT_STEP_MS = CONTAINED_WAIT_WINDOW_MS / 4;
const HOST_WRITTEN_STEP = CONPTY_REPAINT;
const SHELL_WRITTEN_STEP = BOOTED_PROMPT;
const ENCODED_COMMAND_LABEL = 'PowerShell EncodedCommand output';
const CONTAINMENT_VERDICT = `${ENCODED_COMMAND_LABEL} was not reached inside its`;
const SPENT_GRANT_REFUSAL = `the grant for ${ENCODED_COMMAND_LABEL} was spent before the wait could poll once`;

interface ContainedWaitOptions extends WaitOptions {
  backstopAt: number;
}

interface ContainedWaitVerdict {
  settled: 'pending' | 'reached' | 'refused';
  atMs: number;
  message: string;
  buffer: string;
}

function evenCadence(
  chunk: string,
  stepMs: number,
  untilMs: number,
): Array<{ atMs: number; chunk: string }> {
  const steps: Array<{ atMs: number; chunk: string }> = [];
  for (let atMs = stepMs; atMs <= untilMs; atMs += stepMs) steps.push({ atMs, chunk });
  return steps;
}

function watchContainedWait(
  stream: FakeStream,
  options: ContainedWaitOptions,
): { verdict: ContainedWaitVerdict; settled: Promise<void> } {
  const startedAt = performance.now();
  const verdict: ContainedWaitVerdict = {
    settled: 'pending',
    atMs: Number.NaN,
    message: '',
    buffer: '',
  };
  const record = (): void => {
    verdict.atMs = performance.now() - startedAt;
    verdict.buffer = stream.read();
  };
  const settled = waitForCondition(stream, () => false, ENCODED_COMMAND_LABEL, options).then(
    () => {
      verdict.settled = 'reached';
      record();
    },
    (error: unknown) => {
      verdict.settled = 'refused';
      verdict.message = error instanceof Error ? error.message : String(error);
      record();
    },
  );
  return { verdict, settled };
}

async function raceHostNoiseAgainstShellOutput(): Promise<{
  hostNoise: ContainedWaitVerdict;
  shellSpeaking: ContainedWaitVerdict;
}> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const hostNoiseStream = createFakeStream();
  const shellSpeakingStream = createFakeStream();
  const stopHostNoise = scheduleEmissions(
    hostNoiseStream,
    evenCadence(HOST_WRITTEN_STEP, CONTAINED_WAIT_STEP_MS, CONTAINED_WAIT_CONTAINMENT_MS),
  );
  const stopShellSpeaking = scheduleEmissions(
    shellSpeakingStream,
    evenCadence(SHELL_WRITTEN_STEP, CONTAINED_WAIT_STEP_MS, CONTAINED_WAIT_CONTAINMENT_MS),
  );
  const waitOptions: ContainedWaitOptions = {
    stallMs: CONTAINED_WAIT_WINDOW_MS,
    intervalMs: ADVANCEMENT_POLL_MS,
    backstopAt: performance.now() + CONTAINED_WAIT_CONTAINMENT_MS,
  };
  const hostNoise = watchContainedWait(hostNoiseStream, waitOptions);
  const shellSpeaking = watchContainedWait(shellSpeakingStream, waitOptions);
  try {
    await vi.advanceTimersByTimeAsync(CONTAINED_WAIT_CONTAINMENT_MS + ADVANCEMENT_POLL_MS);
    return { hostNoise: hostNoise.verdict, shellSpeaking: shellSpeaking.verdict };
  } finally {
    stopHostNoise();
    stopShellSpeaking();
    await Promise.all([hostNoise.settled, shellSpeaking.settled]);
  }
}

describe('a console host speaking before the shell never renews a wait, and every byte after the shell speaks counts as progress', () => {
  test('console-host attach bytes arriving mid-wait do not renew it, and shell bytes do', async () => {
    const { hostNoise, shellSpeaking } = await raceHostNoiseAgainstShellOutput();
    expect(hostNoise.buffer.length).toBeGreaterThan(HOST_WRITTEN_STEP.length);
    expect(shellSpeaking.buffer.length).toBeGreaterThan(SHELL_WRITTEN_STEP.length);
    expect(shellOutputBeyondAttach(hostNoise.buffer)).toBe('');
    expect(shellOutputBeyondAttach(shellSpeaking.buffer)).toBe(shellSpeaking.buffer);
    expect(hostNoise.settled).toBe('refused');
    expect(shellSpeaking.settled).toBe('refused');
    expect(hostNoise.atMs).toBeLessThan(shellSpeaking.atMs);
    expect(hostNoise.atMs).toBeLessThan(CONTAINED_WAIT_CONTAINMENT_MS);
    expect(shellSpeaking.atMs).toBeGreaterThan(CONTAINED_WAIT_WINDOW_MS);
  });

  test('a shell that speaks once and then leaves the host writing runs to containment, and the verdict names what it counted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    stream.emit(`${ATTACH_PROLOGUE}${SHELL_WRITTEN_STEP}`);
    const stopHostNoise = scheduleEmissions(
      stream,
      evenCadence(HOST_WRITTEN_STEP, CONTAINED_WAIT_STEP_MS, CONTAINED_WAIT_CONTAINMENT_MS),
    );
    const { verdict, settled } = watchContainedWait(stream, {
      stallMs: CONTAINED_WAIT_WINDOW_MS,
      intervalMs: ADVANCEMENT_POLL_MS,
      backstopAt: performance.now() + CONTAINED_WAIT_CONTAINMENT_MS,
    });
    try {
      await vi.advanceTimersByTimeAsync(CONTAINED_WAIT_CONTAINMENT_MS + ADVANCEMENT_POLL_MS);
      expect(verdict.settled).toBe('refused');
      expect(verdict.atMs).toBeGreaterThanOrEqual(CONTAINED_WAIT_CONTAINMENT_MS);
      expect(verdict.message).toContain(CONTAINMENT_VERDICT);
      expect(verdict.message).not.toContain(SILENT_SHELL_VERDICT);
      expect(verdict.message).toContain(
        `${verdict.buffer.length - ATTACH_PROLOGUE.length} characters past the shell's first output`,
      );
    } finally {
      stopHostNoise();
      await settled;
    }
  });
});

const VALIDATED_WAIT = { intervalMs: 5, stallMs: 60 } as const;
const NON_FINITE_BACKSTOP_REFUSAL = `backstop for ${ENCODED_COMMAND_LABEL} must be a finite`;

async function messageFromRefusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the wait under test was expected to be refused and was not');
}

describe('a wait may only be generous about elapsed time once its containment is real', () => {
  test('a containment instant that cannot bound the wait is named instead of polled against', async () => {
    const stream = createFakeStream();
    stream.emit(ATTACH_PROLOGUE);
    for (const backstopAt of [performance.now() + VALIDATED_WAIT.stallMs, 0]) {
      const contained: ContainedWaitOptions = { ...VALIDATED_WAIT, backstopAt };
      const refusal = await messageFromRefusal(() =>
        waitForCondition(stream, () => false, ENCODED_COMMAND_LABEL, contained),
      );
      expect(refusal).toContain(ENCODED_COMMAND_LABEL);
      expect(refusal).not.toContain(NON_FINITE_BACKSTOP_REFUSAL);
    }
    for (const backstopAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const unbounded: ContainedWaitOptions = { ...VALIDATED_WAIT, backstopAt };
      await expect(
        waitForCondition(stream, () => false, ENCODED_COMMAND_LABEL, unbounded),
      ).rejects.toThrow(NON_FINITE_BACKSTOP_REFUSAL);
    }
  });
});

function wedgedBootedStream(): FakeStream {
  const stream = createFakeStream();
  stream.emit(`${ATTACH_PROLOGUE}${BOOTED_PROMPT}`);
  return stream;
}

describe('a grant gone before a wait could poll once is refused as spent, not reported as silence or as a containment the wait had', () => {
  test('a containment a poll fits inside refuses for silence; one that no longer does refuses as a spent grant', async () => {
    const silenced = await messageFromRefusal(() =>
      waitForCondition(wedgedBootedStream(), () => false, ENCODED_COMMAND_LABEL, {
        ...VALIDATED_WAIT,
        backstopAt: performance.now() + VALIDATED_WAIT.stallMs,
      }),
    );
    expect(silenced).toContain(SILENT_SHELL_VERDICT);
    expect(silenced).not.toContain(CONTAINMENT_VERDICT);
    expect(silenced).not.toContain(SPENT_GRANT_REFUSAL);
    for (const backstopAt of [
      performance.now() + VALIDATED_WAIT.intervalMs - 1,
      0,
      performance.now() - VALIDATED_WAIT.stallMs,
    ]) {
      const spent = await messageFromRefusal(() =>
        waitForCondition(wedgedBootedStream(), () => false, ENCODED_COMMAND_LABEL, {
          ...VALIDATED_WAIT,
          backstopAt,
        }),
      );
      expect(spent).toContain(SPENT_GRANT_REFUSAL);
      expect(spent).not.toContain(SILENT_SHELL_VERDICT);
      expect(spent).not.toContain(CONTAINMENT_VERDICT);
    }
  });

  test('a spent grant reaches the refusal class from a plain wait, the way it does from the evaluated-input one', async () => {
    await expect(
      waitForCondition(wedgedBootedStream(), () => false, ENCODED_COMMAND_LABEL, {
        ...VALIDATED_WAIT,
        backstopAt: 0,
      }),
    ).rejects.toBeInstanceOf(HarnessBudgetRefusal);
    await expect(
      waitForShellReady(wedgedBootedStream(), ENCODED_COMMAND_LABEL, {
        ...VALIDATED_WAIT,
        quietSamples: 2,
        backstopAt: 0,
      }),
    ).rejects.toBeInstanceOf(HarnessBudgetRefusal);
    await expect(
      waitForEvaluatedInput(
        wedgedBootedStream(),
        () => undefined,
        INPUT_READY_PROBE,
        ENCODED_COMMAND_LABEL,
        { budgetMs: VALIDATED_WAIT.intervalMs - 2, intervalMs: VALIDATED_WAIT.intervalMs },
      ),
    ).rejects.toBeInstanceOf(HarnessBudgetRefusal);
    const expired = await waitForCondition(
      wedgedBootedStream(),
      () => false,
      ENCODED_COMMAND_LABEL,
      { ...VALIDATED_WAIT, backstopAt: performance.now() + VALIDATED_WAIT.stallMs },
    ).catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(Error);
    expect(expired).not.toBeInstanceOf(HarnessBudgetRefusal);
  });

  test('a condition already true when the wait is called resolves however thin the containment is', async () => {
    for (const backstopAt of [performance.now() + VALIDATED_WAIT.intervalMs - 1, 0]) {
      await expect(
        waitForCondition(wedgedBootedStream(), () => true, ENCODED_COMMAND_LABEL, {
          ...VALIDATED_WAIT,
          backstopAt,
        }),
      ).resolves.toBeUndefined();
      await expect(
        waitForCondition(wedgedBootedStream(), () => false, ENCODED_COMMAND_LABEL, {
          ...VALIDATED_WAIT,
          backstopAt,
        }),
      ).rejects.toBeInstanceOf(HarnessBudgetRefusal);
    }
  });

  test('a wait that observed no shell output at all says so rather than report progress it never saw', async () => {
    const attachOnly = createFakeStream();
    attachOnly.emit(ATTACH_PROLOGUE);
    const stall = await messageFromRefusal(() =>
      waitForCondition(attachOnly, () => false, ENCODED_COMMAND_LABEL, {
        ...VALIDATED_WAIT,
        backstopAt: performance.now() + VALIDATED_WAIT.stallMs,
      }),
    );
    expect(stall).toContain('without any shell output');
    expect(stall).not.toContain(SILENT_SHELL_VERDICT);
    expect(stall).not.toContain("characters past the shell's first output");
  });
});

describe('a wait window the containment cut is named as cut, so a red tells starvation from a stalled shell', () => {
  test('the stall verdict names the window the call site declared only when the containment took it away', async () => {
    const declaredStallMs = VALIDATED_WAIT.stallMs * 4;
    const cut = await messageFromRefusal(() =>
      waitForCondition(wedgedBootedStream(), () => false, ENCODED_COMMAND_LABEL, {
        ...VALIDATED_WAIT,
        stallMs: declaredStallMs,
        backstopAt: performance.now() + VALIDATED_WAIT.stallMs,
      }),
    );
    expect(cut).toContain(
      `after ${VALIDATED_WAIT.stallMs}ms (the containment it runs inside cut the ${declaredStallMs}ms it declared)`,
    );

    const uncut = await messageFromRefusal(() =>
      waitForCondition(wedgedBootedStream(), () => false, ENCODED_COMMAND_LABEL, {
        ...VALIDATED_WAIT,
        backstopAt: performance.now() + declaredStallMs,
      }),
    );
    expect(uncut).toContain(`after ${VALIDATED_WAIT.stallMs}ms ${SILENT_SHELL_VERDICT}`);
    expect(uncut).not.toContain('it declared');
  });

  test('a reduction too small to change the printed number does not claim a cut', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { verdict, settled } = watchContainedWait(wedgedBootedStream(), {
      stallMs: VALIDATED_WAIT.stallMs,
      intervalMs: VALIDATED_WAIT.intervalMs,
      backstopAt: performance.now() + VALIDATED_WAIT.stallMs - 0.4,
    });
    try {
      await vi.advanceTimersByTimeAsync(VALIDATED_WAIT.stallMs + VALIDATED_WAIT.intervalMs);
      expect(verdict.message).toContain(
        `after ${VALIDATED_WAIT.stallMs}ms ${SILENT_SHELL_VERDICT}`,
      );
      expect(verdict.message).not.toContain('it declared');
    } finally {
      await settled;
    }
  });

  test('an input round trip names the silence window its grant cut, and claims no cut when its grant is larger', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const cutStream = createFakeStream();
    const uncutStream = createFakeStream();
    cutStream.emit(BOOTED_PROMPT);
    uncutStream.emit(BOOTED_PROMPT);
    const cut = watchEvaluatedInput(
      cutStream,
      driveEvaluatingShell(cutStream, { evaluates: false }).send,
      { budgetMs: READINESS_CEILING_MS / 8 },
    );
    const uncut = watchEvaluatedInput(
      uncutStream,
      driveEvaluatingShell(uncutStream, { evaluates: false }).send,
      { budgetMs: READINESS_CEILING_MS * 2 },
    );
    await vi.advanceTimersByTimeAsync(READINESS_CEILING_MS * 2);
    await Promise.all([cut.settled, uncut.settled]);
    expect(uncut.verdict.message).toBe(
      `timeout waiting for: input ready after ${READINESS_CEILING_MS}ms ${SILENT_SHELL_VERDICT} (received ${JSON.stringify(BOOTED_PROMPT)})`,
    );
    expect(cut.verdict.message).toBe(
      `timeout waiting for: input ready after ${READINESS_CEILING_MS / 8}ms (the containment it runs inside cut the ${READINESS_CEILING_MS}ms it declared) ${SILENT_SHELL_VERDICT} (received ${JSON.stringify(BOOTED_PROMPT)})`,
    );
  });
});

const QUIET_READY_LABEL = 'interactive shell ready';

interface ShellReadyVerdict {
  settled: 'pending' | 'ready' | 'refused';
  atMs: number;
  message: string;
  error: unknown;
}

function watchShellReady(
  stream: PtyStream,
  options: ShellReadyOptions,
): { verdict: ShellReadyVerdict; settled: Promise<void> } {
  const startedAt = performance.now();
  const verdict: ShellReadyVerdict = {
    settled: 'pending',
    atMs: Number.NaN,
    message: '',
    error: null,
  };
  const settled = waitForShellReady(stream, QUIET_READY_LABEL, options).then(
    () => {
      verdict.settled = 'ready';
      verdict.atMs = performance.now() - startedAt;
    },
    (error: unknown) => {
      verdict.settled = 'refused';
      verdict.atMs = performance.now() - startedAt;
      verdict.message = error instanceof Error ? error.message : String(error);
      verdict.error = error;
    },
  );
  return { verdict, settled };
}

describe('a wait whose readiness is silence is refused at entry when its stall window or its grant cannot outlast that silence', () => {
  test.each([
    ['one poll longer than', VALIDATED_WAIT.stallMs / VALIDATED_WAIT.intervalMs + 1],
    ['exactly as long as', VALIDATED_WAIT.stallMs / VALIDATED_WAIT.intervalMs],
  ])(
    'a quiet window %s the stall window is refused at entry as configuration, never reported as a silent shell',
    async (_position, quietSamples) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const quietWindowMs = quietSamples * VALIDATED_WAIT.intervalMs;
      const booted = createFakeStream();
      booted.emit(BOOTED_PROMPT);
      const { verdict, settled } = watchShellReady(booted, { ...VALIDATED_WAIT, quietSamples });
      await vi.advanceTimersByTimeAsync(quietWindowMs + VALIDATED_WAIT.intervalMs);
      await settled;
      expect({ settled: verdict.settled, message: verdict.message }).toEqual({
        settled: 'refused',
        message: `the stall window for ${QUIET_READY_LABEL} must outlast the ${quietWindowMs}ms of quiet it counts as ready, got ${VALIDATED_WAIT.stallMs}ms`,
      });
      expect(verdict.atMs).toBe(0);
      expect(verdict.error).toBeInstanceOf(Error);
      expect(verdict.error).not.toBeInstanceOf(HarnessBudgetRefusal);
    },
  );

  test('a stall window one poll longer than the quiet window lets a booted shell report ready once that quiet has passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const quietSamples = VALIDATED_WAIT.stallMs / VALIDATED_WAIT.intervalMs - 1;
    const booted = createFakeStream();
    booted.emit(BOOTED_PROMPT);
    const { verdict, settled } = watchShellReady(booted, { ...VALIDATED_WAIT, quietSamples });
    await vi.advanceTimersByTimeAsync(VALIDATED_WAIT.stallMs + VALIDATED_WAIT.intervalMs);
    await settled;
    expect({ settled: verdict.settled, message: verdict.message }).toEqual({
      settled: 'ready',
      message: '',
    });
    expect(verdict.atMs).toBe(quietSamples * VALIDATED_WAIT.intervalMs);
  });

  test('a containment exactly as long as the quiet window is refused at entry as a spent grant, not failed as a containment the wait had', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const quietSamples = VALIDATED_WAIT.stallMs / VALIDATED_WAIT.intervalMs - 1;
    const quietWindowMs = quietSamples * VALIDATED_WAIT.intervalMs;
    const spawning = createFakeStream();
    const { verdict, settled } = watchShellReady(spawning, {
      ...VALIDATED_WAIT,
      quietSamples,
      backstopAt: performance.now() + quietWindowMs,
    });
    spawning.emit(BOOTED_PROMPT);
    await vi.advanceTimersByTimeAsync(quietWindowMs + VALIDATED_WAIT.intervalMs);
    await settled;
    expect({ settled: verdict.settled, message: verdict.message }).toEqual({
      settled: 'refused',
      message: `the grant for ${QUIET_READY_LABEL} was spent before the wait could count ${quietSamples} quiet polls: ${quietWindowMs}ms left does not outlast the ${quietWindowMs}ms they take`,
    });
    expect(verdict.atMs).toBe(0);
    expect(verdict.error).toBeInstanceOf(HarnessBudgetRefusal);
  });

  test('a containment one poll longer than the quiet window lets a shell that boots after the call report ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const quietSamples = VALIDATED_WAIT.stallMs / VALIDATED_WAIT.intervalMs - 1;
    const quietWindowMs = quietSamples * VALIDATED_WAIT.intervalMs;
    const spawning = createFakeStream();
    const { verdict, settled } = watchShellReady(spawning, {
      ...VALIDATED_WAIT,
      quietSamples,
      backstopAt: performance.now() + quietWindowMs + VALIDATED_WAIT.intervalMs,
    });
    spawning.emit(BOOTED_PROMPT);
    await vi.advanceTimersByTimeAsync(quietWindowMs + 2 * VALIDATED_WAIT.intervalMs);
    await settled;
    expect({ settled: verdict.settled, message: verdict.message }).toEqual({
      settled: 'ready',
      message: '',
    });
    expect(verdict.atMs).toBe(quietWindowMs + VALIDATED_WAIT.intervalMs);
  });
});
