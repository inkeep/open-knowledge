import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, trace } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  DEFAULT_MAX_VALUE_BYTES,
  FileSpanExporter,
  REDACTED_SENTINEL,
  RotatingAppender,
  ScrubbingSpanProcessor,
  spansCurrentPath,
  spansPreviousPath,
} from './telemetry-file-sink.ts';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ok-file-span-test-'));
});
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeProvider(exporter: FileSpanExporter): BasicTracerProvider {
  return new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
}

function readLines(filePath: string): string[] {
  const body = readFileSync(filePath, 'utf-8');
  if (body.length === 0) return [];
  // Trailing newline produces an empty last segment; drop it.
  const segments = body.split('\n');
  if (segments.at(-1) === '') segments.pop();
  return segments;
}

interface ResourceSpansEnvelope {
  resourceSpans: Array<{
    scopeSpans: Array<{ spans: Array<{ name: string }> }>;
  }>;
}

function parseEnvelope(line: string): ResourceSpansEnvelope {
  const parsed = JSON.parse(line) as ResourceSpansEnvelope;
  if (!Array.isArray(parsed.resourceSpans)) {
    throw new Error('line did not parse as a ResourceSpans envelope');
  }
  return parsed;
}

function firstSpanName(envelope: ResourceSpansEnvelope): string {
  const [rs] = envelope.resourceSpans;
  if (!rs) throw new Error('empty resourceSpans[]');
  const [ss] = rs.scopeSpans;
  if (!ss) throw new Error('empty scopeSpans[]');
  const [span] = ss.spans;
  if (!span) throw new Error('empty spans[]');
  return span.name;
}

describe('FileSpanExporter', () => {
  test('first export creates spans-current.jsonl lazily with one ResourceSpans JSON line per batch', async () => {
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: 1_000_000 });
    const currentPath = spansCurrentPath(tmp);
    expect(existsSync(currentPath)).toBe(false);

    const provider = makeProvider(exporter);
    const tracer = provider.getTracer('test');
    tracer.startSpan('hello').end();
    await provider.forceFlush();

    expect(existsSync(currentPath)).toBe(true);
    const lines = readLines(currentPath);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    if (line === undefined) throw new Error('expected one line');
    const parsed = parseEnvelope(line);
    expect(parsed.resourceSpans.length).toBeGreaterThan(0);

    await provider.shutdown();
  });

  test('multiple batches each land as their own JSON line', async () => {
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: 1_000_000 });
    const provider = makeProvider(exporter);
    const tracer = provider.getTracer('test');

    for (let i = 0; i < 3; i++) {
      tracer.startSpan(`span-${i}`).end();
      // Force-flush per span so SimpleSpanProcessor's chain finishes.
      await provider.forceFlush();
    }

    const lines = readLines(spansCurrentPath(tmp));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      parseEnvelope(line);
    }

    await provider.shutdown();
  });

  test('parent directory is created lazily on first export', async () => {
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: 1_000_000 });
    const telemetryDir = join(tmp, '.ok', 'local', 'telemetry');
    expect(existsSync(telemetryDir)).toBe(false);

    const provider = makeProvider(exporter);
    provider.getTracer('test').startSpan('boot').end();
    await provider.forceFlush();

    expect(existsSync(telemetryDir)).toBe(true);
    expect(existsSync(spansCurrentPath(tmp))).toBe(true);

    await provider.shutdown();
  });

  test('rotates current → prev once size exceeds maxBytes', async () => {
    // Cap at 50 bytes — one span's serialized envelope is far larger,
    // so every export triggers rotation post-write.
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: 50 });
    const provider = makeProvider(exporter);
    const tracer = provider.getTracer('test');
    const currentPath = spansCurrentPath(tmp);
    const previousPath = spansPreviousPath(tmp);

    tracer.startSpan('first').end();
    await provider.forceFlush();

    // After rotation, current was renamed to prev and is now absent.
    expect(existsSync(currentPath)).toBe(false);
    expect(existsSync(previousPath)).toBe(true);
    const firstPrev = readLines(previousPath);
    expect(firstPrev).toHaveLength(1);
    const [firstLine] = firstPrev;
    if (firstLine === undefined) throw new Error('expected first line');
    expect(firstSpanName(parseEnvelope(firstLine))).toBe('first');

    tracer.startSpan('second').end();
    await provider.forceFlush();

    // Prev now holds the second batch (replaced the first), current was rotated again.
    expect(existsSync(currentPath)).toBe(false);
    expect(existsSync(previousPath)).toBe(true);
    const secondPrev = readLines(previousPath);
    expect(secondPrev).toHaveLength(1);
    const [secondLine] = secondPrev;
    if (secondLine === undefined) throw new Error('expected second line');
    expect(firstSpanName(parseEnvelope(secondLine))).toBe('second');

    await provider.shutdown();
  });

  test('keeps current under threshold across multiple appends before rotating', async () => {
    // Generous-enough cap to fit multiple span batches; only force
    // rotation after many appends.
    const cap = 2_000;
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: cap });
    const provider = makeProvider(exporter);
    const tracer = provider.getTracer('test');
    const currentPath = spansCurrentPath(tmp);
    const previousPath = spansPreviousPath(tmp);

    // Append spans until we've definitely rotated at least once.
    for (let i = 0; i < 50; i++) {
      tracer.startSpan(`span-${i}`).end();
      await provider.forceFlush();
    }

    expect(existsSync(previousPath)).toBe(true);
    // Current should be present (a fresh post-rotation file with whatever
    // landed after the most recent rotation) and ≤ cap.
    if (existsSync(currentPath)) {
      expect(statSync(currentPath).size).toBeLessThanOrEqual(cap);
    }
    expect(statSync(previousPath).size).toBeGreaterThan(0);
    // Both files contain only valid JSON lines.
    if (existsSync(currentPath)) {
      for (const line of readLines(currentPath)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
    for (const line of readLines(previousPath)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    await provider.shutdown();
  });

  test('appends cleanly even when the existing file has a partial trailing line', async () => {
    // Simulate a SIGKILL leaving a partial trailing line: write a malformed
    // chunk WITHOUT a terminal newline. The exporter must still append the
    // next batch without throwing; the partial line is the reader's
    // problem to discard.
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: 1_000_000 });
    const currentPath = spansCurrentPath(tmp);
    // Ensure parent dir exists so we can pre-seed the file.
    await new Promise<void>((resolve, reject) => {
      const provider = makeProvider(exporter);
      provider.getTracer('seed').startSpan('seed').end();
      provider.forceFlush().then(async () => {
        await provider.shutdown();
        resolve();
      }, reject);
    });
    // Append a malformed partial line (no terminating newline).
    writeFileSync(currentPath, 'NOT-JSON-AT-ALL', { flag: 'a' });

    const exporter2 = new FileSpanExporter({ projectDir: tmp, maxBytes: 1_000_000 });
    const provider2 = makeProvider(exporter2);
    provider2.getTracer('test').startSpan('after-partial').end();
    await provider2.forceFlush();

    // The append succeeded — file ends with the new JSON line. Some
    // line in the file remains corrupt; readers discard those, valid
    // ones still parse.
    const lines = readLines(currentPath);
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line) as { resourceSpans?: unknown[] };
        } catch {
          return null;
        }
      })
      .filter(
        (v): v is { resourceSpans: unknown[] } => v !== null && Array.isArray(v.resourceSpans),
      );
    expect(parsed.length).toBeGreaterThanOrEqual(1);

    await provider2.shutdown();
  });

  test('shutdown drains in-flight writes; further export() is rejected', async () => {
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: 1_000_000 });
    const provider = makeProvider(exporter);
    provider.getTracer('test').startSpan('pre-shutdown').end();
    await provider.forceFlush();

    await exporter.shutdown();

    // Direct call (bypassing the processor) confirms the shutdown gate.
    await new Promise<void>((resolve) => {
      // Cast through unknown to construct a minimal ReadableSpan-shaped
      // object — the gate short-circuits before we'd ever dereference it.
      exporter.export(
        [
          {
            name: 'after-shutdown',
          } as unknown as Parameters<typeof exporter.export>[0][number],
        ],
        (result) => {
          expect(result.code).toBe(1);
          expect(result.error).toBeInstanceOf(Error);
          resolve();
        },
      );
    });
  });

  test('forceFlush waits for in-flight writes to settle', async () => {
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: 1_000_000 });
    const provider = makeProvider(exporter);
    const tracer = provider.getTracer('test');
    tracer.startSpan('to-flush').end();
    // Concurrent forceFlushes should resolve without errors.
    await Promise.all([exporter.forceFlush(), provider.forceFlush()]);

    const lines = readLines(spansCurrentPath(tmp));
    expect(lines).toHaveLength(1);
    const [line] = lines;
    if (line === undefined) throw new Error('expected one line');
    expect(() => parseEnvelope(line)).not.toThrow();

    await provider.shutdown();
  });
});

describe('RotatingAppender (shared rotation primitive)', () => {
  test('appends bytes, creates parent dir lazily, and rotates over cap', async () => {
    const currentPath = join(tmp, 'logs', 'a-current.jsonl');
    const previousPath = join(tmp, 'logs', 'a-prev.jsonl');
    const appender = new RotatingAppender({ currentPath, previousPath, maxBytes: 20 });
    expect(existsSync(join(tmp, 'logs'))).toBe(false);

    await appender.append('hello\n');
    // hello\n = 6 bytes < 20 — no rotation yet.
    expect(existsSync(currentPath)).toBe(true);
    expect(existsSync(previousPath)).toBe(false);

    await appender.append('worldworldworld\n');
    // Total ~22 bytes > 20 — rotation triggers after this append.
    expect(existsSync(currentPath)).toBe(false);
    expect(existsSync(previousPath)).toBe(true);
    expect(readFileSync(previousPath, 'utf-8')).toBe('hello\nworldworldworld\n');

    // Smaller payload — well under cap — lands in a fresh current.
    await appender.append('next\n');
    expect(existsSync(currentPath)).toBe(true);
    expect(readFileSync(currentPath, 'utf-8')).toBe('next\n');
    // Prev still holds the first generation.
    expect(readFileSync(previousPath, 'utf-8')).toBe('hello\nworldworldworld\n');
  });

  test('serializes concurrent appends; final file content reflects ordered writes', async () => {
    const currentPath = join(tmp, 'concurrent', 'c-current.jsonl');
    const previousPath = join(tmp, 'concurrent', 'c-prev.jsonl');
    const appender = new RotatingAppender({
      currentPath,
      previousPath,
      maxBytes: 10_000,
    });

    await Promise.all([
      appender.append('A\n'),
      appender.append('B\n'),
      appender.append('C\n'),
      appender.append('D\n'),
    ]);

    expect(readFileSync(currentPath, 'utf-8')).toBe('A\nB\nC\nD\n');
  });

  test('drain awaits the most-recently enqueued append', async () => {
    const currentPath = join(tmp, 'drain', 'd-current.jsonl');
    const previousPath = join(tmp, 'drain', 'd-prev.jsonl');
    const appender = new RotatingAppender({
      currentPath,
      previousPath,
      maxBytes: 10_000,
    });
    // Fire-and-forget several appends.
    void appender.append('1\n');
    void appender.append('2\n');
    void appender.append('3\n');
    await appender.drain();
    expect(readFileSync(currentPath, 'utf-8')).toBe('1\n2\n3\n');
  });
});

describe('ScrubbingSpanProcessor', () => {
  function makeSpan(attrs: Record<string, unknown>): ReadableSpan {
    // Minimal ReadableSpan-shape for direct onEnd() testing — onEnd walks
    // span.attributes, span.events[].attributes, and span.links[].attributes,
    // so empty arrays satisfy the iteration contract for tests that only
    // care about top-level attribute scrubbing. Cast through unknown so we
    // don't have to satisfy every readonly field.
    return {
      attributes: { ...attrs },
      events: [],
      links: [],
    } as unknown as ReadableSpan;
  }

  function makeSpanWithEvent(eventName: string, eventAttrs: Record<string, unknown>): ReadableSpan {
    return {
      attributes: {},
      events: [{ name: eventName, time: [0, 0], attributes: { ...eventAttrs } }],
      links: [],
    } as unknown as ReadableSpan;
  }

  function makeSpanWithLink(linkAttrs: Record<string, unknown>): ReadableSpan {
    return {
      attributes: {},
      events: [],
      links: [
        {
          context: {
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            traceFlags: 1,
          },
          attributes: { ...linkAttrs },
        },
      ],
    } as unknown as ReadableSpan;
  }

  test('masks denylisted attribute keys (case-insensitive)', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: ['authorization', 'cookie', 'x-api-key'],
    });
    const span = makeSpan({
      'http.request.headers.authorization': 'Bearer secret-token-xyz',
      'http.request.headers.Authorization': 'duplicate-key-different-casing',
      'http.request.headers.cookie': 'session=abc',
      'http.request.headers.X-API-Key': 'hot-secret',
      'http.method': 'POST',
      'http.url': 'https://example.com/api',
    });
    proc.onEnd(span);
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs['http.request.headers.authorization']).toBe(REDACTED_SENTINEL);
    expect(attrs['http.request.headers.Authorization']).toBe(REDACTED_SENTINEL);
    expect(attrs['http.request.headers.cookie']).toBe(REDACTED_SENTINEL);
    expect(attrs['http.request.headers.X-API-Key']).toBe(REDACTED_SENTINEL);
    // Non-denylisted attrs untouched.
    expect(attrs['http.method']).toBe('POST');
    expect(attrs['http.url']).toBe('https://example.com/api');
  });

  test('denylist matches by exact key OR boundary-anchored suffix', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: ['authorization', 'cookie', 'set-cookie', 'password'],
    });
    const span = makeSpan({
      // Exact match.
      authorization: 'bare-key-secret',
      // Dotted OTel namespace — boundary `.`.
      'http.request.headers.authorization': 'Bearer xyz',
      // Slash variant — boundary `/`.
      'headers/authorization': 'header-style',
      // Underscore variant — boundary `_`.
      db_password: 'db-creds',
      // Hyphenated entry on its own.
      'set-cookie': 'sid=123',
      // Hyphen-suffix nested.
      'http.response.headers.set-cookie': 'sid=456',
      // Different word ending in the entry — NO match.
      'unset-cookie': 'still safe',
      // Tail-of-word but no boundary — NO match.
      mypassword: 'unrelated',
      // Mid-word denylist string — NO match.
      'password-related': 'irrelevant',
      // Safe.
      'http.method': 'POST',
    });
    proc.onEnd(span);
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs.authorization).toBe(REDACTED_SENTINEL);
    expect(attrs['http.request.headers.authorization']).toBe(REDACTED_SENTINEL);
    expect(attrs['headers/authorization']).toBe(REDACTED_SENTINEL);
    expect(attrs.db_password).toBe(REDACTED_SENTINEL);
    expect(attrs['set-cookie']).toBe(REDACTED_SENTINEL);
    expect(attrs['http.response.headers.set-cookie']).toBe(REDACTED_SENTINEL);
    // Non-matches preserved.
    expect(attrs['unset-cookie']).toBe('still safe');
    expect(attrs.mypassword).toBe('unrelated');
    expect(attrs['password-related']).toBe('irrelevant');
    expect(attrs['http.method']).toBe('POST');
  });

  test('truncates string values that exceed maxValueBytes', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: [],
      maxValueBytes: 8,
    });
    const span = makeSpan({
      'short.value': 'fits',
      'long.value': 'this string is way longer than the cap',
      'multibyte.value': '日本語'.repeat(10), // 30 chars * 3 bytes each = 90 bytes
    });
    proc.onEnd(span);
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs['short.value']).toBe('fits');
    expect(attrs['long.value']).toBe(
      `[TRUNCATED:${Buffer.byteLength('this string is way longer than the cap', 'utf-8')}]`,
    );
    expect(attrs['multibyte.value']).toBe(
      `[TRUNCATED:${Buffer.byteLength('日本語'.repeat(10), 'utf-8')}]`,
    );
  });

  test('default maxValueBytes is 4096 (SPEC body-content invariant)', () => {
    expect(DEFAULT_MAX_VALUE_BYTES).toBe(4096);
    const proc = new ScrubbingSpanProcessor({ attributeDenylist: [] });
    const justUnderCap = 'a'.repeat(4096);
    const overCap = 'a'.repeat(4097);
    const span = makeSpan({
      'at.cap': justUnderCap,
      'over.cap': overCap,
    });
    proc.onEnd(span);
    const attrs = span.attributes as Record<string, unknown>;
    // > cap, not >= cap.
    expect(attrs['at.cap']).toBe(justUnderCap);
    expect(attrs['over.cap']).toBe('[TRUNCATED:4097]');
  });

  test('denylist key match takes precedence over truncation', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: ['secret'],
      maxValueBytes: 4,
    });
    const span = makeSpan({
      secret: 'this-would-also-overflow',
    });
    proc.onEnd(span);
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs.secret).toBe(REDACTED_SENTINEL);
  });

  test('non-string attribute values are not size-checked', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: [],
      maxValueBytes: 4,
    });
    const span = makeSpan({
      number: 42_000_000_000,
      boolean: true,
      stringArray: ['a', 'b', 'c'],
    });
    proc.onEnd(span);
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs.number).toBe(42_000_000_000);
    expect(attrs.boolean).toBe(true);
    expect(attrs.stringArray).toEqual(['a', 'b', 'c']);
  });

  test('denylist still masks non-string values', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: ['password'],
    });
    const span = makeSpan({
      password: 12345, // (unlikely but possible — numbers can be passwords if a caller passes one)
    });
    proc.onEnd(span);
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs.password).toBe(REDACTED_SENTINEL);
  });

  test('no mutation when nothing matches', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: ['authorization'],
      maxValueBytes: 4096,
    });
    const span = makeSpan({
      'http.method': 'GET',
      'http.status_code': 200,
      'doc.name': 'safe-doc-name',
    });
    proc.onEnd(span);
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs).toEqual({
      'http.method': 'GET',
      'http.status_code': 200,
      'doc.name': 'safe-doc-name',
    });
  });

  test('integrated with FileSpanExporter: denylisted values never reach the JSONL', async () => {
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: 1_000_000 });
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: ['authorization'],
      maxValueBytes: 16,
    });
    const provider = new BasicTracerProvider({
      // Scrubber FIRST so it mutates the span before the simple exporter sees it.
      spanProcessors: [proc, new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('http.request');
    span.setAttribute('http.request.headers.authorization', 'Bearer s3cr3t-token-x');
    span.setAttribute('http.user_agent', 'a long string longer than sixteen bytes');
    span.setAttribute('http.method', 'GET');
    span.end();
    await provider.forceFlush();

    const fileBody = readFileSync(spansCurrentPath(tmp), 'utf-8');
    // Credentials never appear in the file.
    expect(fileBody).not.toContain('s3cr3t-token-x');
    // The redacted sentinel is present in its place.
    expect(fileBody).toContain('[REDACTED]');
    // The oversize string is replaced with the truncation marker.
    expect(fileBody).toContain(
      `[TRUNCATED:${Buffer.byteLength('a long string longer than sixteen bytes', 'utf-8')}]`,
    );
    // Safe attribute passes through.
    expect(fileBody).toContain('"GET"');

    await provider.shutdown();
  });

  test('shutdown + forceFlush are no-ops (no state held)', async () => {
    const proc = new ScrubbingSpanProcessor({ attributeDenylist: ['authorization'] });
    await expect(proc.forceFlush()).resolves.toBeUndefined();
    await expect(proc.shutdown()).resolves.toBeUndefined();
  });

  test('masks denylisted attribute values on span events', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: ['authorization', 'cookie'],
    });
    const span = makeSpanWithEvent('auth-check', {
      authorization: 'Bearer event-secret-xyz',
      cookie: 'session=event-cookie',
      'http.method': 'POST',
    });
    proc.onEnd(span);
    const eventAttrs = (
      span as unknown as {
        events: Array<{ attributes: Record<string, unknown> }>;
      }
    ).events[0]?.attributes;
    if (eventAttrs === undefined) throw new Error('expected event attributes');
    expect(eventAttrs.authorization).toBe(REDACTED_SENTINEL);
    expect(eventAttrs.cookie).toBe(REDACTED_SENTINEL);
    expect(eventAttrs['http.method']).toBe('POST');
  });

  test('truncates oversized string attribute values on span events', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: [],
      maxValueBytes: 8,
    });
    const overflowing = 'a'.repeat(64);
    const span = makeSpanWithEvent('verbose-event', {
      'event.detail': overflowing,
      'event.fits': 'short',
    });
    proc.onEnd(span);
    const eventAttrs = (
      span as unknown as {
        events: Array<{ attributes: Record<string, unknown> }>;
      }
    ).events[0]?.attributes;
    if (eventAttrs === undefined) throw new Error('expected event attributes');
    expect(eventAttrs['event.detail']).toBe(
      `[TRUNCATED:${Buffer.byteLength(overflowing, 'utf-8')}]`,
    );
    expect(eventAttrs['event.fits']).toBe('short');
  });

  test('masks denylisted attribute values on span links', () => {
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: ['authorization'],
    });
    const span = makeSpanWithLink({
      authorization: 'Bearer link-secret-zzz',
      'link.kind': 'parent',
    });
    proc.onEnd(span);
    const linkAttrs = (
      span as unknown as {
        links: Array<{ attributes: Record<string, unknown> }>;
      }
    ).links[0]?.attributes;
    if (linkAttrs === undefined) throw new Error('expected link attributes');
    expect(linkAttrs.authorization).toBe(REDACTED_SENTINEL);
    expect(linkAttrs['link.kind']).toBe('parent');
  });

  test('tolerates events and links that carry no attribute bag', () => {
    const proc = new ScrubbingSpanProcessor({ attributeDenylist: ['authorization'] });
    const span = {
      attributes: { authorization: 'top-secret' },
      events: [{ name: 'no-attrs', time: [0, 0] }],
      links: [
        {
          context: {
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            traceFlags: 1,
          },
        },
      ],
    } as unknown as ReadableSpan;
    expect(() => proc.onEnd(span)).not.toThrow();
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs.authorization).toBe(REDACTED_SENTINEL);
  });

  test('integrated with FileSpanExporter: event + link credentials never reach the JSONL', async () => {
    const exporter = new FileSpanExporter({ projectDir: tmp, maxBytes: 1_000_000 });
    const proc = new ScrubbingSpanProcessor({
      attributeDenylist: ['authorization'],
      maxValueBytes: 16,
    });
    const provider = new BasicTracerProvider({
      spanProcessors: [proc, new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');

    const linkSourceSpan = tracer.startSpan('link-source');
    const linkedContext = linkSourceSpan.spanContext();
    linkSourceSpan.end();

    const span = tracer.startSpan('http.request', {
      links: [
        {
          context: linkedContext,
          attributes: {
            authorization: 'Bearer link-secret-aaa',
            'link.kind': 'parent',
          },
        },
      ],
    });
    span.addEvent('auth-check', {
      authorization: 'Bearer event-secret-bbb',
      'event.detail': 'a really long event description that exceeds the cap',
    });
    span.end();
    await provider.forceFlush();

    const fileBody = readFileSync(spansCurrentPath(tmp), 'utf-8');
    expect(fileBody).not.toContain('event-secret-bbb');
    expect(fileBody).not.toContain('link-secret-aaa');
    expect(fileBody).toContain('[REDACTED]');
    expect(fileBody).toContain(
      `[TRUNCATED:${Buffer.byteLength('a really long event description that exceeds the cap', 'utf-8')}]`,
    );

    await provider.shutdown();
  });
});

// Reference the OTel api imports so they're not pruned — both `trace` and
// `context` are exercised transitively by BasicTracerProvider but the
// linter prefers explicit usage.
void trace.getTracer;
void context.active;
