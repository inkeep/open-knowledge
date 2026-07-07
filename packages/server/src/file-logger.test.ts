import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { flushFileLogger, MAX_FILE_SIZE } from './file-logger.ts';

const TEST_DIR = join(tmpdir(), `ok-file-logger-test-${process.pid}`);

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

describe('file logger', () => {
  test('pino.destination writes NDJSON to file', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'test.log');
    const dest = pino.destination({ dest: filePath, sync: true });
    const logger = pino(
      { base: { project: 'my-project' }, timestamp: pino.stdTimeFunctions.isoTime },
      dest,
    );
    logger.info({ foo: 'bar' }, 'hello');
    dest.flushSync();
    const content = Bun.file(filePath).text();
    expect(content).resolves.toContain('"msg":"hello"');
  });

  test('project field is included in records', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'test-project.log');
    const dest = pino.destination({ dest: filePath, sync: true });
    const logger = pino(
      { base: { project: 'test-slug' }, timestamp: pino.stdTimeFunctions.isoTime },
      dest,
    );
    logger.info({}, 'check');
    dest.flushSync();
    const content = Bun.file(filePath).text();
    expect(content).resolves.toContain('"project":"test-slug"');
  });

  test('redact config censors sensitive top-level fields', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'test-redact.log');
    const dest = pino.destination({ dest: filePath, sync: true });
    const logger = pino(
      {
        redact: { paths: ['authorization', '*.authorization'], censor: '[REDACTED]' },
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      dest,
    );
    logger.info({ authorization: 'Bearer sk-secret123' }, 'auth check');
    dest.flushSync();
    const content = Bun.file(filePath).text();
    expect(content).resolves.toContain('[REDACTED]');
  });

  test('rotation renames when file exceeds 5MB', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'big.log');
    const padding = `${'x'.repeat(1024)}\n`;
    let content = '';
    for (let i = 0; i < 5200; i++) content += padding;
    writeFileSync(filePath, content);
    expect(statSync(filePath).size).toBeGreaterThan(MAX_FILE_SIZE);

    // Import and test rotateIfNeeded via createFileLogger side effect
    const { createFileLogger } = require('./file-logger.ts');
    createFileLogger({ name: 'big', filePath });

    const files = readdirSync(TEST_DIR).filter((f: string) => f.startsWith('big.log'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files).toContain('big.log.1');
  });

  test('opens the destination synchronously so same-tick process.exit cannot race the open', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'sync-open.log');
    const { createFileLogger } = require('./file-logger.ts');
    const logger = createFileLogger({ name: 'sync-open', filePath });
    // pino registers an exit hook that calls flushSync() on the destination.
    // With an async open (sync: false), the fs.open callback that assigns the
    // fd cannot have run yet in the same tick, so a command that constructs
    // the logger and process.exit()s synchronously (e.g. `ok start` before
    // `ok init`) makes that hook throw "sonic boom is not ready yet" and dump
    // the minified bundle to the terminal. Replicate the hook: flushSync in
    // the construction tick must find an open fd.
    const stream = (logger as unknown as Record<symbol, { fd: number; flushSync: () => void }>)[
      pino.symbols.streamSym
    ];
    expect(stream.fd).toBeGreaterThanOrEqual(0);
    expect(() => stream.flushSync()).not.toThrow();
  });

  test('createFileLogger unrefs the deferred prune timer so it never blocks process exit', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const { createFileLogger } = require('./file-logger.ts');
    let unrefCalls = 0;
    let scheduledMs: number | undefined;
    // Fake scheduler: records the unref() call (the load-bearing contract) and
    // the delay, and never actually schedules, so no real 5s prune fires here.
    const fakeSetTimeout = ((_cb: () => void, ms?: number) => {
      scheduledMs = ms;
      return {
        unref() {
          unrefCalls += 1;
          return this;
        },
      };
    }) as unknown as typeof setTimeout;

    createFileLogger({
      name: 'unref-contract',
      filePath: join(TEST_DIR, 'unref.log'),
      _setTimeout: fakeSetTimeout,
    });

    expect(unrefCalls).toBe(1);
    expect(scheduledMs).toBe(5000);
  });

  // The credential helper logs then immediately exits; the async (sync:false)
  // destination would otherwise drop that record. flushFileLogger must land it.
  test('flushFileLogger persists a record logged immediately before exit', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'flush.log');
    const prev = process.env.OK_LOG_LEVEL;
    process.env.OK_LOG_LEVEL = 'info';
    try {
      const { createFileLogger } = require('./file-logger.ts');
      const logger = createFileLogger({ name: 'flush', filePath });
      logger.warn({ outcome: 'absent', host: 'github.com' }, '[auth] git-credential get');
      await flushFileLogger(logger);
      const content = readFileSync(filePath, 'utf8');
      expect(content).toContain('git-credential get');
      expect(content).toContain('"outcome":"absent"');
    } finally {
      if (prev === undefined) delete process.env.OK_LOG_LEVEL;
      else process.env.OK_LOG_LEVEL = prev;
    }
  });

  test('flushFileLogger(undefined) resolves without throwing', async () => {
    await expect(flushFileLogger(undefined)).resolves.toBeUndefined();
  });

  // --- flushFileLogger branch coverage (fd-not-open → ready wait, + timeout) ---
  //
  // flushFileLogger reaches the underlying SonicBoom stream via pino's
  // streamSym. A minimal fake logger that carries a fake stream on that symbol
  // exercises the two non-fd-open branches deterministically without real I/O.

  function makeFakeLogger(stream: unknown): PinoLoggerInstance {
    return { [pino.symbols.streamSym]: stream } as unknown as PinoLoggerInstance;
  }

  test("flushFileLogger waits for 'ready' when the fd is not open yet, then flushes", async () => {
    let flushed = false;
    let readyCb: (() => void) | undefined;
    // fd negative (not open) → flushFileLogger must register a 'ready' listener
    // and flush only once it fires.
    const stream = {
      fd: -1,
      flushSync: () => {
        flushed = true;
      },
      once: (event: string, cb: () => void) => {
        if (event === 'ready') readyCb = cb;
      },
    };

    const p = flushFileLogger(makeFakeLogger(stream), 5000);
    // Not flushed yet — still waiting for 'ready'.
    expect(flushed).toBe(false);
    expect(typeof readyCb).toBe('function');

    readyCb?.();
    await p;
    expect(flushed).toBe(true);
  });

  test('flushFileLogger resolves within the bound when the stream never becomes ready', async () => {
    let flushed = false;
    // fd never opens and 'ready' never fires; the timeout path must still
    // resolve the promise within the (tiny) bound.
    const stream = {
      fd: -1,
      flushSync: () => {
        flushed = true;
      },
      once: (_event: string, _cb: () => void) => {
        /* never fires */
      },
    };

    const start = Date.now();
    await flushFileLogger(makeFakeLogger(stream), 30);
    const elapsed = Date.now() - start;
    // Resolved via the timeout, not via a flush.
    expect(flushed).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });

  test('flushFileLogger flushes immediately when the fd is already open', async () => {
    let flushed = false;
    const stream = {
      fd: 7,
      flushSync: () => {
        flushed = true;
      },
      once: () => {
        throw new Error('should not wait for ready when fd is already open');
      },
    };
    await flushFileLogger(makeFakeLogger(stream), 5000);
    expect(flushed).toBe(true);
  });
});
