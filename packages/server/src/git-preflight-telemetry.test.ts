
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { context, metrics, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { GitNotAvailableError, GitTooOldError, type InstallGuidance } from './git-preflight.ts';
import {
  emitPreflightFailureSpan,
  GIT_PREFLIGHT_FAIL_SPAN_NAME,
} from './git-preflight-telemetry.ts';

function makeGuidance(): InstallGuidance {
  return {
    product: 'Git',
    url: 'https://git-scm.com/download/linux',
    options: [{ label: 'apt', command: 'sudo apt install git', requiresAdmin: true }],
  };
}

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
});

describe('GIT_PREFLIGHT_FAIL_SPAN_NAME', () => {
  test('is pinned to the FR8 AC8.1 string', () => {
    expect(GIT_PREFLIGHT_FAIL_SPAN_NAME).toBe('ok.preflight.git.fail');
  });
});

describe('emitPreflightFailureSpan — GitNotAvailableError', () => {
  test('emits one span with reason=not_available + empty detected_version', () => {
    const err = new GitNotAvailableError('linux', makeGuidance());
    emitPreflightFailureSpan(err);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.name).toBe('ok.preflight.git.fail');
    expect(span?.attributes['ok.platform']).toBe('linux');
    expect(span?.attributes['ok.preflight.git.reason']).toBe('not_available');
    expect(span?.attributes['ok.preflight.git.detected_version']).toBe('');
  });

  test('preserves the platform tag from the error verbatim', () => {
    const err = new GitNotAvailableError('darwin', makeGuidance());
    emitPreflightFailureSpan(err);
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes['ok.platform']).toBe('darwin');
  });
});

describe('emitPreflightFailureSpan — GitTooOldError', () => {
  test('emits one span with reason=too_old + detected version triple', () => {
    const err = new GitTooOldError('linux', '2.20.0', '2.31.0', '/usr/bin/git', makeGuidance());
    emitPreflightFailureSpan(err);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.name).toBe('ok.preflight.git.fail');
    expect(span?.attributes['ok.platform']).toBe('linux');
    expect(span?.attributes['ok.preflight.git.reason']).toBe('too_old');
    expect(span?.attributes['ok.preflight.git.detected_version']).toBe('2.20.0');
  });

  test('Windows variant: ok.platform=win32', () => {
    const err = new GitTooOldError(
      'win32',
      '2.20.0',
      '2.31.0',
      'C\\Program Files\\Git\\cmd\\git.exe',
      makeGuidance(),
    );
    emitPreflightFailureSpan(err);
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes['ok.platform']).toBe('win32');
  });
});

describe('emitPreflightFailureSpan — cardinality discipline (FR8 AC8.5)', () => {
  test('attribute set is exactly the three FR8-pinned keys', () => {
    const err = new GitNotAvailableError('linux', makeGuidance());
    emitPreflightFailureSpan(err);
    const [span] = exporter.getFinishedSpans();
    const keys = Object.keys(span?.attributes ?? {}).sort();
    expect(keys).toEqual([
      'ok.platform',
      'ok.preflight.git.detected_version',
      'ok.preflight.git.reason',
    ]);
  });

  test('does not carry guidance URL or resolved path as attributes', () => {
    const err = new GitTooOldError('darwin', '2.20.0', '2.31.0', '/opt/homebrew/bin/git', {
      product: 'Git',
      url: 'https://git-scm.com/download/mac',
      options: [{ label: 'brew', command: 'brew install git', requiresAdmin: false }],
    });
    emitPreflightFailureSpan(err);
    const [span] = exporter.getFinishedSpans();
    const attrs = span?.attributes ?? {};
    const values = Object.values(attrs).map((v) => String(v));
    expect(values.some((v) => v.includes('git-scm.com'))).toBe(false);
    expect(values.some((v) => v.includes('/opt/homebrew'))).toBe(false);
  });
});

describe('emitPreflightFailureSpan — multiple invocations (per-attempt emission)', () => {
  test('each call produces a distinct span', () => {
    const err = new GitNotAvailableError('linux', makeGuidance());
    emitPreflightFailureSpan(err);
    emitPreflightFailureSpan(err);
    emitPreflightFailureSpan(err);
    expect(exporter.getFinishedSpans()).toHaveLength(3);
  });
});
