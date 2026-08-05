/**
 * Renderer slides telemetry — assert the emitter starts a span with the
 * canonical `ok.slides.opened` name, and that an OTel SDK fault (a `getTracer` /
 * `startSpan` throw from the third-party boundary) is contained: it must never
 * escape the user-action handler that calls the emitter and surface as a UI
 * crash.
 *
 * The OTel boundary is faked with `spyOn(trace, 'getTracer')` rather than
 * `vi.doMock('@opentelemetry/api')`: a module mock persists in the shared
 * unit-test module registry and would clobber the real provider that
 * `lib/perf/otel-spans.test.ts` registers. The spy is installed per-test and
 * restored in `afterEach`, so nothing bleeds into another file's tracer. Mirrors
 * `lib/terminal-telemetry.test.ts`.
 */

import { type Tracer, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import { recordSlidesOpened } from './slides-telemetry';

const spanNames: string[] = [];
let startSpanThrows = false;
let getTracerSpy: Mock<typeof trace.getTracer>;

beforeEach(() => {
  spanNames.length = 0;
  startSpanThrows = false;
  getTracerSpy = vi.spyOn(trace, 'getTracer').mockImplementation(
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

describe('renderer slides telemetry — span name', () => {
  test('recordSlidesOpened starts ok.slides.opened', () => {
    recordSlidesOpened();
    expect(spanNames).toEqual(['ok.slides.opened']);
  });
});

describe('renderer slides telemetry — SDK fault isolation', () => {
  test('a startSpan throw does not escape recordSlidesOpened', () => {
    startSpanThrows = true;
    expect(() => recordSlidesOpened()).not.toThrow();
  });
});
