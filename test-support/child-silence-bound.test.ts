import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import { format } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runChildWithSilenceBound, watchForSilence } from './child-silence-bound.test-helper';

const BOUND_MS = 1_000;
const NO_LIMIT_REACHED = 64 * 1024 * 1024;
const NEVER_REACHED_MS = 600_000;

describe('watchForSilence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('output on either stream re-arms the bound, so a child that keeps printing is never stopped however long it runs', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let silences = 0;
    const release = watchForSilence([stdout, stderr], BOUND_MS, () => {
      silences += 1;
    });
    for (const stream of [stdout, stderr, stdout, stderr, stderr, stdout, stderr, stdout]) {
      stream.emit('data', 'progress\n');
      vi.advanceTimersByTime(BOUND_MS - 1);
    }
    expect(silences).toBe(0);
    vi.advanceTimersByTime(1);
    expect(silences).toBe(1);
    release();
  });

  test('a stream that stays silent for the bound is reported once, and only once', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stdout = new EventEmitter();
    let silences = 0;
    const release = watchForSilence([stdout], BOUND_MS, () => {
      silences += 1;
    });
    vi.advanceTimersByTime(BOUND_MS - 1);
    expect(silences).toBe(0);
    vi.advanceTimersByTime(1);
    expect(silences).toBe(1);
    vi.advanceTimersByTime(BOUND_MS * 10);
    expect(silences).toBe(1);
    release();
  });

  test('a released watch neither fires nor re-arms', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stdout = new EventEmitter();
    let silences = 0;
    const release = watchForSilence([stdout], BOUND_MS, () => {
      silences += 1;
    });
    release();
    stdout.emit('data', 'late output\n');
    vi.advanceTimersByTime(BOUND_MS * 10);
    expect(silences).toBe(0);
    expect(stdout.listenerCount('data')).toBe(0);
  });
});

function runNode(
  signal: AbortSignal,
  script: string,
  { silenceBoundMs = NEVER_REACHED_MS, outputLimitBytes = NO_LIMIT_REACHED } = {},
) {
  return runChildWithSilenceBound(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: process.env,
    signal,
    silenceBoundMs,
    outputLimitBytes,
  });
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function captureTestLog(): () => string {
  const written: string[] = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...data: unknown[]) => {
      written.push(`${format(...data)}\n`);
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  }
  return () => written.join('');
}

describe('runChildWithSilenceBound', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('a child that ends on its own resolves with its exit status, its signal and both streams', async ({
    signal,
  }) => {
    const run = await runNode(
      signal,
      "process.stdout.write('to stdout\\n'); process.stderr.write('to stderr\\n'); process.exitCode = 3;",
    );
    expect(run.status).toBe(3);
    expect(run.signal).toBeNull();
    expect(run.output).toBe('to stdout\n\nto stderr\n');
  });

  test('a child that prints nothing for the bound is stopped, and the run rejects with that reason instead of an exit status', async ({
    signal,
  }) => {
    captureTestLog();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = runNode(signal, 'setInterval(() => {}, 1 << 30);', { silenceBoundMs: BOUND_MS });
    vi.advanceTimersByTime(BOUND_MS);
    await expect(run).rejects.toThrow(`because it printed nothing for ${BOUND_MS} ms`);
  });

  test('a stop kills the child with SIGKILL, the one signal a child can neither handle nor ignore', async ({
    signal,
  }) => {
    captureTestLog();
    const requested: Array<NodeJS.Signals | number | undefined> = [];
    const deliver = ChildProcess.prototype.kill;
    vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
      this: ChildProcess,
      requestedSignal?: NodeJS.Signals | number,
    ) {
      requested.push(requestedSignal);
      return deliver.call(this, 'SIGKILL');
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = runNode(signal, 'setInterval(() => {}, 1 << 30);', { silenceBoundMs: BOUND_MS });
    vi.advanceTimersByTime(BOUND_MS);
    await expect(run).rejects.toThrow(`because it printed nothing for ${BOUND_MS} ms`);
    expect(requested).toEqual([constants.signals.SIGKILL]);
  });

  test('a child that prints past the output limit is stopped, and the run rejects with the output it printed', async ({
    signal,
  }) => {
    captureTestLog();
    const limit = 1024;
    const error = await runNode(
      signal,
      "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1 << 30);",
      { outputLimitBytes: limit },
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`because it printed more than ${limit} bytes`);
    expect(message).toMatch(/x{1025,}/);
  });

  test('a silence stop reaches the test log when it happens, naming the command and the reason, before the run settles or anything awaits it', async ({
    signal,
  }) => {
    const script = 'setInterval(() => {}, 1 << 30);';
    const testLog = captureTestLog();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = runNode(signal, script, { silenceBoundMs: BOUND_MS });
    vi.advanceTimersByTime(BOUND_MS);
    const loggedAtTheStop = testLog();
    await expect(run).rejects.toThrow(`because it printed nothing for ${BOUND_MS} ms`);
    expect(loggedAtTheStop).toContain(`printed nothing for ${BOUND_MS} ms`);
    expect(loggedAtTheStop).toContain(script);
  });

  test('an output-limit stop reaches the test log by the time the run settles, with the command, the reason and the output the child printed so far', async ({
    signal,
  }) => {
    const script =
      "process.stdout.write('printed before the stop'.toUpperCase()); setInterval(() => {}, 1 << 30);";
    const limit = 16;
    const testLog = captureTestLog();
    let loggedBySettling = '';
    const run = runNode(signal, script, { outputLimitBytes: limit }).finally(() => {
      loggedBySettling = testLog();
    });
    await expect(run).rejects.toThrow(`because it printed more than ${limit} bytes`);
    expect(loggedBySettling).toContain(`printed more than ${limit} bytes`);
    expect(loggedBySettling).toContain(script);
    expect(loggedBySettling).toContain('PRINTED BEFORE THE STOP');
  });

  test("aborting the caller's signal stops the child and rejects with the abort reason", async () => {
    const caller = new AbortController();
    const reason = new Error('the test ended');
    const run = runNode(caller.signal, 'setInterval(() => {}, 1 << 30);');
    caller.abort(reason);
    await expect(run).rejects.toBe(reason);
  });
});
