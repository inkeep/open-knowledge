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
  harnessTimeouts,
  type PtyStream,
  resolveHarnessBudgetMs,
  shellOutputBeyondAttach,
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

const FAST_READY = { intervalMs: 5, quietSamples: 20, timeoutMs: 5_000 } as const;

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

  test('reports ready once the stream settles instead of waiting out the budget', async () => {
    const stream = createFakeStream();
    stream.emit('PS C:\\project> ');
    const started = Date.now();
    await waitForShellReady(stream, 'shell ready', FAST_READY);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('never reports a silent shell ready', async () => {
    const stream = createFakeStream();
    await expect(
      waitForShellReady(stream, 'shell ready', { intervalMs: 5, quietSamples: 3, timeoutMs: 120 }),
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
    const budget = createHarnessBudget(FAKE_BUDGET_MS, FAKE_RESERVE_MS);
    const atStart = budget.grantMs('this scenario started');
    await vi.advanceTimersByTimeAsync(FAKE_BUDGET_MS / 4);
    expect(budget.grantMs('this scenario started')).toBe(atStart - FAKE_BUDGET_MS / 4);
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
      timeoutMs: 10,
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
    const stream = createFakeStream();
    const timer = setTimeout(() => stream.fail('spawn-error: posix_spawnp failed'), 20);
    const started = Date.now();
    try {
      await expect(
        waitForCondition(stream, () => false, 'evaluated command output', {
          intervalMs: 5,
          timeoutMs: 3_000,
        }),
      ).rejects.toThrow(/posix_spawnp failed/u);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      clearTimeout(timer);
    }
  });

  test('surfaces an early exit instead of expiring as a timeout', async () => {
    const stream = createFakeStream();
    const timer = setTimeout(() => stream.fail('exited (code 1, signal none)'), 20);
    try {
      await expect(
        waitForCondition(stream, () => false, 'evaluated command output', {
          intervalMs: 5,
          timeoutMs: 3_000,
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
        timeoutMs: 200,
      }),
    ).resolves.toBeUndefined();
  });

  test('a timeout that cannot bound the wait is named instead of polled against', async () => {
    const stream = createFakeStream();
    for (const timeoutMs of [Number.NaN, 0, -1]) {
      await expect(
        waitForCondition(stream, () => false, 'evaluated command output', {
          timeoutMs,
          intervalMs: 5,
        }),
      ).rejects.toThrow(/timeout for evaluated command output must be a positive finite duration/u);
    }
  });

  test('names what did arrive when a condition times out', async () => {
    const stream = createFakeStream();
    stream.emit('PS C:\\project> Write-Output "HARNESS_$((6*7))_DONE"');
    await expect(
      waitForCondition(stream, () => false, 'evaluated command output', {
        intervalMs: 5,
        timeoutMs: 60,
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
        timeoutMs: 2_000,
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
        waitForCondition(io, () => false, 'shell ready', { intervalMs: 5, timeoutMs: 100 }),
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
        waitForCondition(io, () => false, 'shell ready', { intervalMs: 5, timeoutMs: 100 }),
      ).rejects.toThrow(/shell failed before shell ready: exited \(code 3, signal none\)/u);
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
const INPUT_READY_FAST = { roundTripTimeoutMs: 200, intervalMs: 5 } as const;
const BOOTED_PROMPT = 'PS C:\\project> ';
const SLOW_EVALUATION_MS = 120;
const READINESS_CEILING_MS = 16_000;

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
        roundTripTimeoutMs: 5_000,
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

  test('the round trip, measured from a booted shell, keeps the 16 second ceiling', async () => {
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
    expect(outcome).toMatch(
      new RegExp(`^timeout waiting for: input ready after ${READINESS_CEILING_MS}ms`, 'u'),
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
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { evaluates: false });
    stream.fail('exited (code 1, signal none)');
    const startedAt = Date.now();
    await expect(
      waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
        roundTripTimeoutMs: 5_000,
        intervalMs: 5,
        budgetMs: 5_000,
      }),
    ).rejects.toThrow(/shell died before producing output for input ready, probe unwritten/u);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
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

  test('a shell that boots but never answers is named at the round trip, not at startup', async () => {
    const stream = createFakeStream();
    stream.emit(`${ATTACH_PROLOGUE}${BOOTED_PROMPT}`);
    const shell = driveEvaluatingShell(stream, { evaluates: false });
    try {
      await expect(
        waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
          budgetMs: 5_000,
          roundTripTimeoutMs: 200,
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
        { budgetMs: 5_000, roundTripTimeoutMs: 2_000, intervalMs: 5 },
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
        { budgetMs: 5_000, roundTripTimeoutMs: 2_000, intervalMs: 5 },
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
          roundTripTimeoutMs: Number.NaN,
          intervalMs: 5,
        }),
      ).rejects.toThrow(/round-trip timeout for input ready must be a positive finite duration/u);
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

  test('startup that outruns its grant is named as such, with the probe unsent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stream = createFakeStream();
    stream.emit(ATTACH_PROLOGUE);
    const shell = driveEvaluatingShell(stream);
    const boot = setTimeout(() => stream.emit(BOOTED_PROMPT), 25);
    let outcome: string = 'pending';
    const pending = waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
      budgetMs: 20,
      intervalMs: 15,
    }).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : String(error);
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(40);
      expect(outcome).toMatch(/^shell startup spent the 20ms budget for input ready/u);
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
