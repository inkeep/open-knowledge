/**
 * Renderer terminal telemetry — assert each emitter starts a span with the
 * canonical `ok.desktop.*` name, and that an OTel SDK fault (a `getTracer` /
 * `startSpan` throw from the third-party boundary) is contained — it must never
 * escape the React effect or user-action handler that calls the emitter and
 * surface as a UI crash.
 *
 * The OTel boundary is faked with `spyOn(trace, 'getTracer')` rather than
 * `mock.module('@opentelemetry/api')`: a module mock persists in the shared
 * unit-test module registry and would clobber the real provider that
 * `lib/perf/otel-spans.test.ts` registers. The spy is installed per-test and
 * restored in `afterEach`, so nothing bleeds into another file's tracer.
 */
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import { type Tracer, trace } from '@opentelemetry/api';
import { recordShellConsentGranted, recordTerminalOpened } from './terminal-telemetry';

const spanNames: string[] = [];
let startSpanThrows = false;
let getTracerSpy: Mock<typeof trace.getTracer>;

beforeEach(() => {
  spanNames.length = 0;
  startSpanThrows = false;
  getTracerSpy = spyOn(trace, 'getTracer').mockImplementation(
    () =>
      ({
        startSpan: (name: string) => {
          if (startSpanThrows) throw new Error('otel provider fault');
          spanNames.push(name);
          return { end: () => undefined };
        },
      }) as unknown as Tracer,
  );
});

afterEach(() => {
  getTracerSpy.mockRestore();
});

describe('renderer terminal telemetry — span names', () => {
  test('recordTerminalOpened starts ok.desktop.terminalOpened', () => {
    recordTerminalOpened();
    expect(spanNames).toEqual(['ok.desktop.terminalOpened']);
  });

  test('recordShellConsentGranted starts ok.desktop.shellConsentGranted', () => {
    recordShellConsentGranted();
    expect(spanNames).toEqual(['ok.desktop.shellConsentGranted']);
  });
});

describe('renderer terminal telemetry — SDK fault isolation', () => {
  test('a startSpan throw does not escape recordTerminalOpened', () => {
    startSpanThrows = true;
    expect(() => recordTerminalOpened()).not.toThrow();
  });

  test('a startSpan throw does not escape recordShellConsentGranted', () => {
    startSpanThrows = true;
    expect(() => recordShellConsentGranted()).not.toThrow();
  });
});
