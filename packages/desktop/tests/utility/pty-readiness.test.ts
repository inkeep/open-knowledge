import { describe, expect, test } from 'vitest';
import type { PtyProcessLike, PtySpawnOptions, SpawnPty } from '../../src/utility/pty-host.ts';
import {
  buildCwdFileProofCommand,
  createPtyHostProbe,
  type PtyStream,
  waitForCondition,
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
