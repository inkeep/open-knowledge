import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  getMeter,
  getTracer,
  initTelemetry,
  type LocalSinkOptions,
  shutdownTelemetry,
} from './telemetry.ts';
import { spansCurrentPath } from './telemetry-file-sink.ts';

const DEFAULT_DENYLIST = ['authorization', 'cookie'] as const;

function makeLocalSinkOpts(projectDir: string): LocalSinkOptions {
  return {
    projectDir,
    spansMaxBytes: 1_048_576,
    attributeDenylist: DEFAULT_DENYLIST,
  };
}


describe('Telemetry', () => {
  let tmp: string;
  beforeEach(async () => {
    await shutdownTelemetry();
    trace.disable();
    metrics.disable();
    context.disable();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TIMEOUT;
    tmp = mkdtempSync(join(tmpdir(), 'ok-telemetry-test-'));
  });

  afterEach(async () => {
    await shutdownTelemetry();
    trace.disable();
    metrics.disable();
    context.disable();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  describe('Gate combination 1 — both off (file sink absent + push disabled)', () => {
    it('returns no-op tracer + meter when OTEL_SDK_DISABLED is unset', () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      delete process.env.OTEL_SDK_DISABLED;
      try {
        const { tracer, meter } = initTelemetry();
        expect(tracer).toBeDefined();
        expect(meter).toBeDefined();

        const span = tracer.startSpan('noop-span');
        expect(span.isRecording()).toBe(false);
        span.end();
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
    });

    it('returns no-op when OTEL_SDK_DISABLED=true (explicit opt-out)', () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'true';
      try {
        const { tracer } = initTelemetry();
        const span = tracer.startSpan('noop-span');
        expect(span.isRecording()).toBe(false);
        span.end();
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
    });

    it('returns no-op when OTEL_SDK_DISABLED is set to any non-"false" string', () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'yes';
      try {
        const { tracer } = initTelemetry();
        const span = tracer.startSpan('noop-span');
        expect(span.isRecording()).toBe(false);
        span.end();
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
    });
  });

  describe('Gate combination 2 — file sink only (push disabled)', () => {
    it('registers a recording tracer and lands a span on disk', async () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      delete process.env.OTEL_SDK_DISABLED;
      try {
        initTelemetry({ localSink: makeLocalSinkOpts(tmp) });
        const tracer = getTracer();
        const span = tracer.startSpan('file-sink-only');
        expect(span.isRecording()).toBe(true);
        span.end();

        await shutdownTelemetry();
        const body = readFileSync(spansCurrentPath(tmp), 'utf-8');
        expect(body.length).toBeGreaterThan(0);
        const lines = body.trim().split('\n');
        const parsed = JSON.parse(lines[0] ?? '{}');
        expect(parsed).toHaveProperty('resourceSpans');
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
    });

    it('strips credential attributes via the ScrubbingSpanProcessor before writing', async () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      delete process.env.OTEL_SDK_DISABLED;
      try {
        initTelemetry({ localSink: makeLocalSinkOpts(tmp) });
        const tracer = getTracer();
        const span = tracer.startSpan('with-credentials', {
          attributes: {
            'http.request.headers.authorization': 'Bearer SUPER-SECRET-XYZ',
            'http.method': 'GET',
          },
        });
        span.end();

        await shutdownTelemetry();
        const body = readFileSync(spansCurrentPath(tmp), 'utf-8');
        expect(body).not.toContain('SUPER-SECRET-XYZ');
        expect(body).toContain('[REDACTED]');
        expect(body).toContain('GET');
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
    });
  });

  describe('Gate combination 3 — push only (file sink absent)', () => {
    it('returns a recording tracer without creating any on-disk artifacts', () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'false';
      try {
        initTelemetry();
        const tracer = getTracer();
        const span = tracer.startSpan('push-only');
        expect(span.isRecording()).toBe(true);
        span.end();

        expect(existsSync(spansCurrentPath(tmp))).toBe(false);
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
    });

    it('strips credential attributes even when only OTLP push is active', async () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      const savedEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const savedTimeout = process.env.OTEL_EXPORTER_OTLP_TIMEOUT;
      const { createServer: createHttpServer } = await import('node:http');
      const captured: Buffer[] = [];
      const server = createHttpServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          captured.push(Buffer.concat(chunks));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
      });
      await new Promise<void>((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        server.close();
        throw new Error('server address unavailable');
      }
      const port = address.port;
      process.env.OTEL_SDK_DISABLED = 'false';
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
      process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '2000';
      try {
        initTelemetry();
        const tracer = getTracer();
        const span = tracer.startSpan('push-only-with-credentials', {
          attributes: {
            'http.request.headers.authorization': 'Bearer SUPER-SECRET-XYZ',
            'http.method': 'GET',
          },
        });
        span.end();

        await shutdownTelemetry();
        await new Promise<void>((resolveServer) => server.close(() => resolveServer()));

        expect(captured.length).toBeGreaterThan(0);
        const body = Buffer.concat(captured).toString('utf-8');
        expect(body).toContain('[REDACTED]');
        expect(body).not.toContain('SUPER-SECRET-XYZ');
        expect(body).toContain('GET');
      } finally {
        if (saved === undefined) delete process.env.OTEL_SDK_DISABLED;
        else process.env.OTEL_SDK_DISABLED = saved;
        if (savedEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
        else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedEndpoint;
        if (savedTimeout === undefined) delete process.env.OTEL_EXPORTER_OTLP_TIMEOUT;
        else process.env.OTEL_EXPORTER_OTLP_TIMEOUT = savedTimeout;
      }
    });
  });

  describe('Gate combination 4 — both pipelines on', () => {
    it('records spans AND writes them to disk when both gates are enabled', async () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'false';
      try {
        initTelemetry({ localSink: makeLocalSinkOpts(tmp) });
        const tracer = getTracer();
        const span = tracer.startSpan('both-pipelines');
        expect(span.isRecording()).toBe(true);
        span.end();

        await shutdownTelemetry();
        const body = readFileSync(spansCurrentPath(tmp), 'utf-8');
        expect(body).toContain('both-pipelines');
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
    });
  });

  describe('initTelemetry idempotency', () => {
    it('returns same providers on second call (push enabled)', () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'false';
      try {
        const first = initTelemetry();
        const second = initTelemetry();
        const span1 = first.tracer.startSpan('idempotent-1');
        const span2 = second.tracer.startSpan('idempotent-2');
        expect(span1.isRecording()).toBe(true);
        expect(span2.isRecording()).toBe(true);
        span1.end();
        span2.end();
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
    });

    it('returns same providers on second call (file sink enabled)', () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      delete process.env.OTEL_SDK_DISABLED;
      try {
        const first = initTelemetry({ localSink: makeLocalSinkOpts(tmp) });
        const second = initTelemetry({ localSink: makeLocalSinkOpts(tmp) });
        const span1 = first.tracer.startSpan('idempotent-file-1');
        const span2 = second.tracer.startSpan('idempotent-file-2');
        expect(span1.isRecording()).toBe(true);
        expect(span2.isRecording()).toBe(true);
        span1.end();
        span2.end();
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
    });
  });

  describe('shutdownTelemetry', () => {
    it('is idempotent — calling twice does not throw', async () => {
      await shutdownTelemetry();
      await shutdownTelemetry();
    });

    it('completes after enabled-push init without throwing', async () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'false';
      try {
        initTelemetry();
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
      await shutdownTelemetry();
    });

    it('completes after file-sink-only init without throwing', async () => {
      initTelemetry({ localSink: makeLocalSinkOpts(tmp) });
      await shutdownTelemetry();
    });

    it('completes after both-pipelines init without throwing', async () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'false';
      try {
        initTelemetry({ localSink: makeLocalSinkOpts(tmp) });
      } finally {
        process.env.OTEL_SDK_DISABLED = saved;
      }
      await shutdownTelemetry();
    });

    it('clears its timeout timer on fast-path resolve (no event-loop hold)', async () => {
      initTelemetry({ localSink: makeLocalSinkOpts(tmp) });
      const t0 = performance.now();
      await shutdownTelemetry();
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(2_000);
    });
  });

  describe('getTracer and getMeter convenience functions', () => {
    it('returns tracer and meter instances', () => {
      const tracer = getTracer();
      const meter = getMeter();
      expect(tracer).toBeDefined();
      expect(meter).toBeDefined();
      expect(typeof tracer.startSpan).toBe('function');
    });
  });

  describe('InMemorySpanExporter integration', () => {
    it('captures spans with correct name and attributes when SDK is registered', () => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      trace.setGlobalTracerProvider(provider);

      try {
        const tracer = getTracer();
        const span = tracer.startSpan('test.operation', {
          attributes: {
            'test.key': 'test-value',
            'test.number': 42,
          },
        });
        expect(span.isRecording()).toBe(true);
        span.end();

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].name).toBe('test.operation');
        expect(spans[0].attributes['test.key']).toBe('test-value');
        expect(spans[0].attributes['test.number']).toBe(42);
      } finally {
        provider.shutdown();
      }
    });

    it('captures multiple spans in correct order', () => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      trace.setGlobalTracerProvider(provider);

      try {
        const tracer = getTracer();
        const span1 = tracer.startSpan('span-1');
        span1.end();
        const span2 = tracer.startSpan('span-2');
        span2.end();

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(2);
        expect(spans[0].name).toBe('span-1');
        expect(spans[1].name).toBe('span-2');
      } finally {
        provider.shutdown();
      }
    });
  });

  describe('Partial-init failure mode (MeterProvider setup throws)', () => {
    it('keeps the TracerProvider recording when MeterProvider setup throws', async () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'false';
      const originalSetMeter = metrics.setGlobalMeterProvider.bind(metrics);
      const patched = metrics as unknown as {
        setGlobalMeterProvider: (mp: unknown) => boolean;
      };
      patched.setGlobalMeterProvider = () => {
        throw new Error('test: forced MeterProvider registration failure');
      };
      try {
        initTelemetry({ localSink: makeLocalSinkOpts(tmp) });

        const tracer = getTracer();
        const span = tracer.startSpan('span-after-meter-failure');
        expect(span.isRecording()).toBe(true);
        span.end();

        await expect(shutdownTelemetry()).resolves.toBeUndefined();
      } finally {
        patched.setGlobalMeterProvider = originalSetMeter;
        if (saved === undefined) delete process.env.OTEL_SDK_DISABLED;
        else process.env.OTEL_SDK_DISABLED = saved;
      }
    });

    it('falls back to no-op tracer when the throw beats TracerProvider commit', async () => {
      const saved = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'false';
      const originalSetTracer = trace.setGlobalTracerProvider.bind(trace);
      const patched = trace as unknown as {
        setGlobalTracerProvider: (tp: unknown) => boolean;
      };
      patched.setGlobalTracerProvider = () => {
        throw new Error('test: forced TracerProvider registration failure');
      };
      try {
        initTelemetry({ localSink: makeLocalSinkOpts(tmp) });
        const tracer = getTracer();
        const span = tracer.startSpan('after-tracer-failure');
        expect(span.isRecording()).toBe(false);
        span.end();
      } finally {
        patched.setGlobalTracerProvider = originalSetTracer;
        if (saved === undefined) delete process.env.OTEL_SDK_DISABLED;
        else process.env.OTEL_SDK_DISABLED = saved;
      }
    });

    it('keeps the TracerProvider recording when propagator setup throws', async () => {
      const originalSetPropagator = propagation.setGlobalPropagator.bind(propagation);
      const patched = propagation as unknown as {
        setGlobalPropagator: (p: unknown) => boolean;
      };
      patched.setGlobalPropagator = () => {
        throw new Error('test: forced propagator registration failure');
      };
      try {
        initTelemetry({ localSink: makeLocalSinkOpts(tmp) });

        const tracer = getTracer();
        const span = tracer.startSpan('span-after-propagator-failure');
        expect(span.isRecording()).toBe(true);
        span.end();

        await expect(shutdownTelemetry()).resolves.toBeUndefined();
      } finally {
        patched.setGlobalPropagator = originalSetPropagator;
      }
    });
  });
});
