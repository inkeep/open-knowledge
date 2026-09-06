import { describe, expect, test } from 'vitest';
import type { PtyProcessLike, PtySpawnOptions, SpawnPty } from '../../src/utility/pty-host.ts';
import {
  buildCwdFileProofCommand,
  createPtyHostProbe,
  INPUT_READY_RESET,
  type PtyStream,
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
  reset: INPUT_READY_RESET,
} as const;
const INPUT_READY_FAST = { timeoutMs: 60, intervalMs: 5, attempts: 5 } as const;
const INPUT_READY_EXHAUSTED = new RegExp(
  `timeout waiting for: input ready[\\s\\S]*gave up after ${INPUT_READY_FAST.attempts} attempts`,
  'u',
);

function driveEvaluatingShell(
  stream: FakeStream,
  options: { swallowFirst: number; evaluates?: boolean; corruptsLine?: boolean },
): { sent: string[]; send: (data: string) => void } {
  const sent: string[] = [];
  let swallowed = 0;
  let partialLine = false;
  return {
    sent,
    send: (data) => {
      sent.push(data);
      if (data === INPUT_READY_RESET) {
        partialLine = false;
        return;
      }
      const typed = data.replace(/\r$/u, '');
      const output = evaluateFakePowerShellCommand(typed);
      if (output === null) return;
      if (swallowed < options.swallowFirst) {
        swallowed += 1;
        if (options.corruptsLine === true) partialLine = true;
        return;
      }
      if (options.evaluates === false) return;
      if (partialLine) return;
      stream.emit(`${typed}\r\n${output}\r\n`);
    },
  };
}

describe('evaluated-input readiness', () => {
  test('pins the line reset as a real ETX rather than an empty string', () => {
    expect(INPUT_READY_PROBE.reset).toBe('\u0003');
  });

  test('sends once when the shell evaluates the first probe', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { swallowFirst: 0 });
    const attempts = await waitForEvaluatedInput(
      stream,
      shell.send,
      INPUT_READY_PROBE,
      'input ready',
      INPUT_READY_FAST,
    );
    expect(attempts).toBe(1);
    expect(shell.sent).toEqual([INPUT_READY_PROBE.input]);
  });

  test('recovers when a console still initializing swallows the first keystrokes', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { swallowFirst: 2 });
    const attempts = await waitForEvaluatedInput(
      stream,
      shell.send,
      INPUT_READY_PROBE,
      'input ready',
      INPUT_READY_FAST,
    );
    expect(attempts).toBe(3);
    expect(stream.read()).toContain(INPUT_READY_MARKER);
    expect(shell.sent).toEqual([
      INPUT_READY_PROBE.input,
      INPUT_READY_PROBE.input,
      INPUT_READY_PROBE.reset,
      INPUT_READY_PROBE.input,
    ]);
  });

  test('recovers a wholly dropped probe by re-sending, without a reset', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { swallowFirst: 1 });
    const attempts = await waitForEvaluatedInput(
      stream,
      shell.send,
      INPUT_READY_PROBE,
      'input ready',
      INPUT_READY_FAST,
    );
    expect(attempts).toBe(2);
    expect(shell.sent).toEqual([INPUT_READY_PROBE.input, INPUT_READY_PROBE.input]);
  });

  test('needs the reset when a dropped probe left a partial line', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { swallowFirst: 1, corruptsLine: true });
    const attempts = await waitForEvaluatedInput(
      stream,
      shell.send,
      INPUT_READY_PROBE,
      'input ready',
      INPUT_READY_FAST,
    );
    expect(attempts).toBe(3);
    expect(shell.sent).toEqual([
      INPUT_READY_PROBE.input,
      INPUT_READY_PROBE.input,
      INPUT_READY_PROBE.reset,
      INPUT_READY_PROBE.input,
    ]);
  });

  test('a shell that only echoes the probe never reports ready', async () => {
    const stream = createFakeStream();
    await expect(
      waitForEvaluatedInput(
        stream,
        (data) => stream.emit(data),
        INPUT_READY_PROBE,
        'input ready',
        INPUT_READY_FAST,
      ),
    ).rejects.toThrow(INPUT_READY_EXHAUSTED);
    expect(stream.read()).toContain('Write-Output');
    expect(stream.read()).not.toContain(INPUT_READY_MARKER);
  });

  test('a shell that never evaluates fails once the attempt budget is spent', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { swallowFirst: 0, evaluates: false });
    await expect(
      waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', INPUT_READY_FAST),
    ).rejects.toThrow(INPUT_READY_EXHAUSTED);
    expect(shell.sent.filter((data) => data === INPUT_READY_PROBE.input)).toHaveLength(
      INPUT_READY_FAST.attempts,
    );
  });

  test('falls back to the module attempt budget when the caller omits one', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { swallowFirst: 0, evaluates: false });
    await expect(
      waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', {
        timeoutMs: INPUT_READY_FAST.timeoutMs,
        intervalMs: INPUT_READY_FAST.intervalMs,
      }),
    ).rejects.toThrow(/gave up after 4 attempts/u);
    expect(shell.sent.filter((data) => data === INPUT_READY_PROBE.input)).toHaveLength(4);
  });

  test('rejects a probe whose own echo would satisfy it', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { swallowFirst: 0 });
    await expect(
      waitForEvaluatedInput(
        stream,
        shell.send,
        { ...INPUT_READY_PROBE, input: `echo ${INPUT_READY_MARKER}` },
        'input ready',
        INPUT_READY_FAST,
      ),
    ).rejects.toThrow(/must not contain its marker/u);
    expect(shell.sent).toEqual([]);
  });

  test('chains the underlying wait failure as the cause', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { swallowFirst: 0, evaluates: false });
    const error = await waitForEvaluatedInput(
      stream,
      shell.send,
      INPUT_READY_PROBE,
      'input ready',
      INPUT_READY_FAST,
    ).catch((thrown: unknown) => thrown as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toMatch(/timeout waiting for: input ready/u);
  });

  test('a dead shell short-circuits instead of burning the attempt budget', async () => {
    const stream = createFakeStream();
    const shell = driveEvaluatingShell(stream, { swallowFirst: 99 });
    stream.fail('exited (code 1, signal none)');
    await expect(
      waitForEvaluatedInput(stream, shell.send, INPUT_READY_PROBE, 'input ready', INPUT_READY_FAST),
    ).rejects.toThrow(/shell failed before input ready/u);
    expect(shell.sent).toEqual([INPUT_READY_PROBE.input]);
  });
});
