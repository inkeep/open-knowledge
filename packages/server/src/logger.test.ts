import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  createTestLogger,
  getLogger,
  installTestLoggers,
  loggerFactory,
  PinoLogger,
} from './logger';
import { logsCurrentPath, logsPreviousPath } from './telemetry-file-sink';

describe('Logger', () => {
  beforeEach(() => {
    loggerFactory.reset();
  });

  describe('LoggerFactory', () => {
    it('should return PinoLogger by default', () => {
      const logger = loggerFactory.getLogger('test');
      expect(logger).toBeInstanceOf(PinoLogger);
    });

    it('should cache logger instances', () => {
      const logger1 = loggerFactory.getLogger('test');
      const logger2 = loggerFactory.getLogger('test');
      expect(logger1).toBe(logger2);
    });

    it('should use custom logger factory', () => {
      const customLogger = new PinoLogger('custom');
      const customFactory = vi.fn(() => customLogger);

      loggerFactory.configure({ loggerFactory: customFactory });

      const logger = loggerFactory.getLogger('test');
      expect(customFactory).toHaveBeenCalledWith('test');
      expect(logger).toBe(customLogger);
    });

    it('should use default logger when configured', () => {
      const defaultLogger = new PinoLogger('default');
      loggerFactory.configure({ defaultLogger });

      const logger = loggerFactory.getLogger('test');
      expect(logger).toBe(defaultLogger);
    });

    it('should clear cache when reconfigured', () => {
      const logger1 = loggerFactory.getLogger('test');
      loggerFactory.configure({ defaultLogger: new PinoLogger('reconfigured') });
      const logger2 = loggerFactory.getLogger('test');
      expect(logger1).not.toBe(logger2);
    });

    it('should reset to default state', () => {
      loggerFactory.configure({ defaultLogger: new PinoLogger('configured') });
      loggerFactory.reset();

      const logger = loggerFactory.getLogger('test');
      expect(logger).toBeInstanceOf(PinoLogger);
    });
  });

  describe('getLogger', () => {
    it('should return logger from factory', () => {
      const logger = getLogger('test');
      expect(logger).toBeInstanceOf(PinoLogger);
    });
  });

  describe('PinoLogger', () => {
    it('should expose transport management', () => {
      const logger = new PinoLogger('test');
      expect(logger.getTransports()).toEqual([]);
    });

    it('should expose the underlying pino instance', () => {
      const logger = new PinoLogger('test');
      const instance = logger.getPinoInstance();
      expect(instance).toBeDefined();
      expect(typeof instance.info).toBe('function');
    });
  });

  describe('Test helpers', () => {
    it('createTestLogger returns a silent PinoLogger', () => {
      const logger = createTestLogger();
      expect(logger).toBeInstanceOf(PinoLogger);
      expect(logger.getPinoInstance().level).toBe('silent');
    });

    it('createTestLogger accepts a custom name', () => {
      const logger = createTestLogger('my-test');
      expect(logger.getPinoInstance().bindings().name).toBe('my-test');
    });

    it('installTestLoggers makes getLogger() return silent loggers', () => {
      installTestLoggers();
      const logger = getLogger('anything');
      expect(logger.getPinoInstance().level).toBe('silent');
    });
  });

  describe('PinoFileSink wiring', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'ok-logger-test-'));
    });
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    interface ParsedLogRecord {
      level: number;
      msg: string;
      trace_id?: string;
      span_id?: string;
      trace_flags?: number;
      [key: string]: unknown;
    }

    function readLogLines(filePath: string): ParsedLogRecord[] {
      const body = readFileSync(filePath, 'utf-8');
      if (body.length === 0) return [];
      const segments = body.split('\n');
      if (segments.at(-1) === '') segments.pop();
      return segments.map((line) => JSON.parse(line) as ParsedLogRecord);
    }

    /**
     * Poll `readLogLines` until it returns `expectedCount` records or the
     * timeout expires. `await flushFileSink()` returns when Pino's worker
     * has been signalled but Linux overlayfs in CI sometimes needs a few
     * extra ms for the inode's visible byte count to catch up — macOS
     * settles in microseconds, Linux occasionally returns one record short
     * on the first read. Polling preserves the assertion's strict shape
     * (`toHaveLength(expectedCount)`) without papering over a real bug:
     * if the records never appear, the final read still produces the
     * actual short array and the assertion fails with the same diagnostic.
     */
    async function readLogLinesWhen(
      filePath: string,
      expectedCount: number,
      timeoutMs = 1_000,
    ): Promise<ParsedLogRecord[]> {
      const start = Date.now();
      let records = readLogLines(filePath);
      while (records.length < expectedCount && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        records = readLogLines(filePath);
      }
      return records;
    }

    it('writes Pino JSON records to the file destination', async () => {
      const logger = new PinoLogger('test', {
        options: { level: 'info' },
        fileSink: { projectDir: tmp, maxBytes: 1_000_000 },
      });
      const filePath = logsCurrentPath(tmp);
      expect(existsSync(filePath)).toBe(false);

      logger.info({ ctx: 'a' }, 'hello-from-file-sink');
      await logger.flushFileSink();

      expect(existsSync(filePath)).toBe(true);
      const records = readLogLines(filePath);
      expect(records).toHaveLength(1);
      const [record] = records;
      if (!record) throw new Error('expected one record');
      expect(record.msg).toBe('hello-from-file-sink');
      expect(record.ctx).toBe('a');
      expect(record.level).toBe(30); // pino info level
    });

    it('creates parent directory lazily on first record', async () => {
      const logger = new PinoLogger('test', {
        options: { level: 'info' },
        fileSink: { projectDir: tmp, maxBytes: 1_000_000 },
      });
      const logsDir = join(tmp, '.ok', 'local', 'logs');
      expect(existsSync(logsDir)).toBe(false);

      logger.info({}, 'first-record');
      await logger.flushFileSink();

      expect(existsSync(logsDir)).toBe(true);
      expect(existsSync(logsCurrentPath(tmp))).toBe(true);
    });

    it('rotates current → prev once file size exceeds maxBytes', async () => {
      // Small cap to force rotation after each substantial record.
      const logger = new PinoLogger('test', {
        options: { level: 'info' },
        fileSink: { projectDir: tmp, maxBytes: 80 },
      });
      const currentPath = logsCurrentPath(tmp);
      const previousPath = logsPreviousPath(tmp);

      // Each record's JSON form is ~150+ bytes (includes name, pid, hostname,
      // timestamps, msg, level) — well over the 80-byte cap.
      logger.info({}, 'first-large-record');
      await logger.flushFileSink();

      // After the first write, the post-write size already exceeds 80,
      // so current was rotated to prev.
      expect(existsSync(currentPath)).toBe(false);
      expect(existsSync(previousPath)).toBe(true);
      const prevRecords = readLogLines(previousPath);
      expect(prevRecords).toHaveLength(1);
      const [firstPrev] = prevRecords;
      if (!firstPrev) throw new Error('expected first record in prev');
      expect(firstPrev.msg).toBe('first-large-record');

      logger.info({}, 'second-large-record');
      await logger.flushFileSink();

      // The second write lands in a fresh current that also tips the
      // post-write cap, so it rotates again — replacing prev.
      expect(existsSync(currentPath)).toBe(false);
      expect(existsSync(previousPath)).toBe(true);
      const secondPrevRecords = readLogLines(previousPath);
      expect(secondPrevRecords).toHaveLength(1);
      const [secondPrev] = secondPrevRecords;
      if (!secondPrev) throw new Error('expected second record in prev');
      expect(secondPrev.msg).toBe('second-large-record');
    });

    it('configure(pinoConfig) reconfigures already-cached loggers in place (captured refs gain the sink)', async () => {
      // A module-level `const log = getLogger('x')` captures the logger BEFORE
      // bootServer wires the file sink. configure() must upgrade that SAME
      // instance in place — not orphan it by clearing the cache — or those
      // subsystems' diagnostics never reach bug-report bundles.
      const captured = loggerFactory.getLogger('captured-early');
      captured.info({}, 'before-configure');
      await captured.flushFileSink();
      // No sink yet → nothing on disk.
      expect(existsSync(logsCurrentPath(tmp))).toBe(false);

      loggerFactory.configure({
        pinoConfig: {
          options: { level: 'info' },
          fileSink: { projectDir: tmp, maxBytes: 1_000_000 },
        },
      });

      // Same reference, now upgraded with the file sink.
      expect(loggerFactory.getLogger('captured-early')).toBe(captured);
      captured.info({}, 'after-configure');
      await captured.flushFileSink();

      const records = await readLogLinesWhen(logsCurrentPath(tmp), 1);
      expect(records.map((r) => r.msg)).toEqual(['after-configure']);
    });

    it('OK_CONSOLE_LEVEL raises the stdout stream without flooring the file sink', async () => {
      // The interactive `ok start` path raises the console to 'warn' to keep
      // the terminal legible, but the on-disk sink MUST keep capturing INFO
      // diagnostics for bug-report bundles. Verify an info record still lands
      // on disk when the console level is raised above it.
      const prev = process.env.OK_CONSOLE_LEVEL;
      process.env.OK_CONSOLE_LEVEL = 'warn';
      try {
        const logger = new PinoLogger('test', {
          options: { level: 'info' },
          fileSink: { projectDir: tmp, maxBytes: 1_000_000 },
        });
        // Instance level must be the more-verbose of (file=info, console=warn)
        // so the logger-level gate doesn't drop INFO before per-stream filtering.
        expect(logger.getPinoInstance().level).toBe('info');

        logger.info({}, 'info-to-disk');
        logger.warn({}, 'warn-to-disk');
        await logger.flushFileSink();

        const records = await readLogLinesWhen(logsCurrentPath(tmp), 2);
        expect(records.map((r) => r.msg)).toEqual(['info-to-disk', 'warn-to-disk']);
        // The INFO record is the load-bearing one — it would be lost if the
        // console-level raise leaked onto the file-sink stream.
        expect(records[0]?.level).toBe(30);
      } finally {
        if (prev === undefined) delete process.env.OK_CONSOLE_LEVEL;
        else process.env.OK_CONSOLE_LEVEL = prev;
      }
    });

    it('omits file destination when fileSink config is absent (no .ok/local/logs created)', async () => {
      const logger = new PinoLogger('test', {
        options: { level: 'info' },
      });
      const logsDir = join(tmp, '.ok', 'local', 'logs');

      logger.info({}, 'no-file-sink-here');
      await logger.flushFileSink(); // no-op when no sink

      expect(existsSync(logsDir)).toBe(false);
      expect(existsSync(logsCurrentPath(tmp))).toBe(false);
    });

    it('preserves trace context in file records when an active span exists', async () => {
      // OTel context propagation requires a registered ContextManager; the
      // default Noop manager makes context.with() a no-op, which would
      // route the logger.info() call through an empty active context and
      // strip the trace fields.
      const contextManager = new AsyncLocalStorageContextManager().enable();
      context.setGlobalContextManager(contextManager);
      const provider = new BasicTracerProvider();
      try {
        const tracer = provider.getTracer('logger-trace-test');
        const logger = new PinoLogger('test', {
          options: { level: 'info' },
          fileSink: { projectDir: tmp, maxBytes: 1_000_000 },
        });

        const span = tracer.startSpan('parent-span');
        const ctx = trace.setSpan(context.active(), span);
        const expected = span.spanContext();
        context.with(ctx, () => {
          logger.info({}, 'inside-span');
        });
        span.end();

        await logger.flushFileSink();

        const records = readLogLines(logsCurrentPath(tmp));
        expect(records).toHaveLength(1);
        const [record] = records;
        if (!record) throw new Error('expected one record');
        expect(record.msg).toBe('inside-span');
        expect(record.trace_id).toBe(expected.traceId);
        expect(record.span_id).toBe(expected.spanId);
        expect(record.trace_flags).toBe(expected.traceFlags);
      } finally {
        await provider.shutdown();
        // Disable the global context manager so it doesn't leak into
        // other tests. context.disable() resets to the Noop manager.
        contextManager.disable();
        context.disable();
      }
    });

    it('flushFileSink is a no-op when no fileSink is wired', async () => {
      const logger = new PinoLogger('test', {
        options: { level: 'info' },
      });
      await expect(logger.flushFileSink()).resolves.toBeUndefined();
    });

    it('the file sink rebuilds cleanly across updateOptions / addTransport churn', async () => {
      // Defensive coverage: buildInstance() clears activeFileSink each call.
      // After a rebuild that drops the file sink (no fileSinkOpts path),
      // flushFileSink should still resolve.
      const logger = new PinoLogger('test', {
        options: { level: 'info' },
        fileSink: { projectDir: tmp, maxBytes: 1_000_000 },
      });
      logger.info({}, 'first');
      await logger.flushFileSink();
      // updateOptions triggers recreateInstance() — file sink should be
      // re-attached since fileSinkOpts is still set.
      logger.updateOptions({ level: 'debug' });
      logger.info({}, 'second');
      await logger.flushFileSink();

      const records = readLogLines(logsCurrentPath(tmp));
      // Both records landed even though the sink was rebuilt.
      // (Order is deterministic: appender serializes through a promise chain.)
      expect(records.map((r) => r.msg)).toEqual(['first', 'second']);
    });

    it('size cap reads the appender threshold; one above-cap write rotates', async () => {
      const logger = new PinoLogger('test', {
        options: { level: 'info' },
        fileSink: { projectDir: tmp, maxBytes: 50 },
      });
      const currentPath = logsCurrentPath(tmp);
      const previousPath = logsPreviousPath(tmp);

      logger.info({}, 'lots-of-content-to-trigger-rotation');
      await logger.flushFileSink();

      // Either current is absent (rotated) or it's under the cap.
      if (existsSync(currentPath)) {
        expect(statSync(currentPath).size).toBeLessThanOrEqual(50);
      }
      expect(existsSync(previousPath)).toBe(true);
    });

    it('flushAllFileSinks drains every cached PinoLogger created via the factory', async () => {
      // Two named loggers obtained through the factory — each PinoLogger
      // instance owns its own PinoFileSink with a separate RotatingAppender
      // promise chain, so draining one does not drain the other. Shutdown
      // must walk every cached instance for log records written in the final
      // moments before process.exit() to land on disk.
      loggerFactory.configure({
        pinoConfig: {
          options: { level: 'info' },
          fileSink: { projectDir: tmp, maxBytes: 1_000_000 },
        },
      });
      const a = loggerFactory.getLogger('a');
      const b = loggerFactory.getLogger('b');
      expect(a).not.toBe(b);

      a.info({}, 'from-a');
      b.info({}, 'from-b');

      await loggerFactory.flushAllFileSinks();

      const filePath = logsCurrentPath(tmp);
      expect(existsSync(filePath)).toBe(true);
      const records = readLogLines(filePath);
      const messages = records.map((r) => r.msg).sort();
      expect(messages).toEqual(['from-a', 'from-b']);
    });

    it('flushAllFileSinks resolves when no loggers are cached or none have file sinks', async () => {
      // Idempotency + no-op contract — shutdown calls this unconditionally;
      // it must not throw when the file sink was never configured.
      await expect(loggerFactory.flushAllFileSinks()).resolves.toBeUndefined();

      loggerFactory.configure({
        pinoConfig: { options: { level: 'info' } },
      });
      loggerFactory.getLogger('no-sink');
      await expect(loggerFactory.flushAllFileSinks()).resolves.toBeUndefined();
    });

    it('credential-shaped log fields are masked before reaching the file sink', async () => {
      // Pino-side defense-in-depth: a log record carrying authorization or
      // similar credential keys must land on disk with [REDACTED] in place
      // of the secret. Mirrors ScrubbingSpanProcessor on the span side so
      // bug-report bundles never carry credentials regardless of which
      // surface (span or log) the author accidentally emitted them on.
      const logger = new PinoLogger('cred-test', {
        options: { level: 'info' },
        fileSink: { projectDir: tmp, maxBytes: 1_000_000 },
        redactPaths: [
          'authorization',
          '*.authorization',
          'cookie',
          '*.cookie',
          'password',
          '*.password',
        ],
      });
      logger.info({ authorization: 'Bearer SUPER-SECRET-XYZ', method: 'GET' }, 'flat-credentials');
      logger.info(
        { req: { authorization: 'Bearer NESTED-CRED', method: 'POST' } },
        'nested-credentials',
      );
      await logger.flushFileSink();

      // Poll for both records to land — Pino's worker may need a few ms
      // past `flushFileSink` resolution on Linux overlayfs.
      const records = await readLogLinesWhen(logsCurrentPath(tmp), 2);
      expect(records).toHaveLength(2);
      const flat = records[0];
      const nested = records[1];
      if (!flat || !nested) throw new Error('expected two records');
      expect(flat.authorization).toBe('[REDACTED]');
      expect(flat.method).toBe('GET');
      // Pino redact recurses one level via the `*.authorization` pattern.
      const req = nested.req as Record<string, unknown> | undefined;
      expect(req).toBeDefined();
      expect(req?.authorization).toBe('[REDACTED]');
      expect(req?.method).toBe('POST');
      // Belt-and-braces — the raw secrets must NEVER appear in the bytes
      // landed on disk.
      const raw = JSON.stringify(records);
      expect(raw).not.toContain('SUPER-SECRET-XYZ');
      expect(raw).not.toContain('NESTED-CRED');
    });

    it('deep-nested credentials (depth 2+) are masked when the per-depth wildcard set is wired', async () => {
      // The dominant HTTP-logging shape — `{ req: { headers: { authorization } } }`
      // — is depth 2 and slips past Pino's one-level `*.key` glob. Pino's
      // redact engine treats only `*` as a single-segment wildcard (it has
      // no deep wildcard), so the production boot.ts wiring enumerates one
      // wildcard segment per depth (`*.k`, `*.*.k`, `*.*.*.k`, …). This
      // test pins that contract: with the explicit per-depth set, records
      // up to PINO_REDACT_MAX_DEPTH (5) land on disk fully scrubbed.
      const denylist = ['authorization', 'cookie'];
      const maxDepth = 5;
      const redactPaths: string[] = [];
      for (const key of denylist) {
        redactPaths.push(key);
        for (let depth = 1; depth <= maxDepth; depth++) {
          redactPaths.push(`${'*.'.repeat(depth)}${key}`);
        }
      }
      const logger = new PinoLogger('deep-cred-test', {
        options: { level: 'info' },
        fileSink: { projectDir: tmp, maxBytes: 1_000_000 },
        redactPaths,
      });
      logger.info({ authorization: 'TOP-LEVEL-AUTH' }, 'top');
      logger.info({ req: { authorization: 'DEPTH-1-AUTH' } }, 'depth-1');
      logger.info(
        { req: { headers: { authorization: 'DEPTH-2-AUTH', cookie: 'DEPTH-2-COOKIE' } } },
        'depth-2',
      );
      logger.info({ outer: { req: { headers: { authorization: 'DEPTH-3-AUTH' } } } }, 'depth-3');
      await logger.flushFileSink();

      const records = await readLogLinesWhen(logsCurrentPath(tmp), 4);
      expect(records).toHaveLength(4);
      const [top, d1, d2, d3] = records;
      if (!top || !d1 || !d2 || !d3) throw new Error('expected four records');

      expect(top.authorization).toBe('[REDACTED]');

      const d1Req = d1.req as Record<string, unknown> | undefined;
      expect(d1Req?.authorization).toBe('[REDACTED]');

      const d2Req = d2.req as { headers?: Record<string, unknown> } | undefined;
      expect(d2Req?.headers?.authorization).toBe('[REDACTED]');
      expect(d2Req?.headers?.cookie).toBe('[REDACTED]');

      const d3Outer = d3.outer as { req?: { headers?: Record<string, unknown> } } | undefined;
      expect(d3Outer?.req?.headers?.authorization).toBe('[REDACTED]');

      const raw = JSON.stringify(records);
      expect(raw).not.toContain('TOP-LEVEL-AUTH');
      expect(raw).not.toContain('DEPTH-1-AUTH');
      expect(raw).not.toContain('DEPTH-2-AUTH');
      expect(raw).not.toContain('DEPTH-2-COOKIE');
      expect(raw).not.toContain('DEPTH-3-AUTH');
    });
  });
});
