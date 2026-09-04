import { type Context, type Span, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

interface StartedSpan {
  readonly name: string;
  readonly parent: Context | undefined;
  readonly span: FakeSpan;
}

const started: StartedSpan[] = [];

class FakeSpan {
  readonly attributes: Record<string, unknown> = {};
  status: number | undefined;
  ended = false;
  endedAt: number | undefined;
  isRecording() {
    return true;
  }
  setAttribute(key: string, value: unknown) {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: Record<string, unknown>) {
    Object.assign(this.attributes, attrs);
    return this;
  }
  setStatus(status: { code: number }) {
    this.status = status.code;
    return this;
  }
  end(endTime?: number) {
    this.ended = true;
    this.endedAt = endTime;
  }
}

const actual = await import('@inkeep/open-knowledge-server');

vi.doMock('@inkeep/open-knowledge-server', () => ({
  ...actual,
  getTracer: () => ({
    startSpan(name: string, _options: unknown, parent?: Context) {
      const span = new FakeSpan();
      started.push({ name, parent, span });
      return span as unknown as Span;
    },
  }),
}));

const { beginSendTrace } = await import('./bug-report-trace.ts');

function parentSpanOf(entry: StartedSpan): Span | undefined {
  return entry.parent ? trace.getSpan(entry.parent) : undefined;
}

describe('bug-report send trace', () => {
  beforeEach(() => {
    started.length = 0;
    process.env.OTEL_SDK_DISABLED = 'false';
  });

  afterEach(() => {
    process.env.OTEL_SDK_DISABLED = undefined;
  });

  test('a send opens its own root span and closes it with the outcome', () => {
    const t = beginSendTrace({ 'ok.bug_report.include_screenshot': true });
    t.phase('mint', { 'http.response.status_code': 200 }, 1_000, 1_200);
    t.end('sent');

    const root = started[0];
    expect(root.name).toBe('ok.bug-report.send');
    expect(parentSpanOf(root)).toBeUndefined();
    expect(root.span.attributes['ok.bug_report.outcome']).toBe('sent');
    expect(root.span.ended).toBe(true);

    const mint = started[1];
    expect(mint.name).toBe('ok.bug-report.mint');
    expect(mint.span.endedAt).toBe(1_200);
  });

  test('concurrent sends never adopt each other as parents', () => {
    const a = beginSendTrace();
    const b = beginSendTrace();
    a.phase('upload', {}, 10, 20);
    b.phase('upload', {}, 11, 21);
    a.end('sent');
    b.end('upload-failed');

    const roots = started.filter((s) => s.name === 'ok.bug-report.send');
    const phases = started.filter((s) => s.name === 'ok.bug-report.upload');
    expect(roots).toHaveLength(2);
    expect(phases).toHaveLength(2);

    const [rootA, rootB] = roots;
    const [phaseA, phaseB] = phases;

    expect(parentSpanOf(rootA)).toBeUndefined();
    expect(parentSpanOf(rootB)).toBeUndefined();
    expect(parentSpanOf(phaseA)).toBe(rootA.span);
    expect(parentSpanOf(phaseB)).toBe(rootB.span);
    expect(parentSpanOf(phaseA)).not.toBe(rootB.span);
  });

  test('only a genuine upload failure marks the span as an error', () => {
    for (const outcome of ['sent', 'email-drafted', 'send-in-flight'] as const) {
      started.length = 0;
      beginSendTrace().end(outcome);
      expect(started[0].span.status).toBe(1);
    }
    started.length = 0;
    beginSendTrace().end('upload-failed');
    expect(started[0].span.status).toBe(2);
  });

  test('end is idempotent and later phases are dropped', () => {
    const t = beginSendTrace();
    t.end('sent');
    t.end('upload-failed');
    t.phase('complete', {}, 1, 2);

    const roots = started.filter((s) => s.name === 'ok.bug-report.send');
    expect(roots).toHaveLength(1);
    expect(roots[0].span.attributes['ok.bug_report.outcome']).toBe('sent');
    expect(started.filter((s) => s.name === 'ok.bug-report.complete')).toHaveLength(0);
  });

  test('telemetry stays off unless explicitly enabled', () => {
    process.env.OTEL_SDK_DISABLED = undefined;
    const t = beginSendTrace();
    t.phase('mint', {}, 1, 2);
    t.end('sent');
    expect(started).toHaveLength(0);
  });
});
