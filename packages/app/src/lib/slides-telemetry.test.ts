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
