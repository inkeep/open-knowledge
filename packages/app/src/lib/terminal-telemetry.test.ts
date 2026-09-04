import { type Tracer, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import { recordShellConsentGranted, recordTerminalOpened } from './terminal-telemetry';

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
