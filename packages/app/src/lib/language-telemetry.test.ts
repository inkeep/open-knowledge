import { type Attributes, type Tracer, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import { recordLanguagePreferenceChanged } from './language-telemetry';

const spans: { name: string; attributes: Attributes | undefined }[] = [];
let startSpanThrows = false;
let getTracerSpy: Mock<typeof trace.getTracer>;

beforeEach(() => {
  spans.length = 0;
  startSpanThrows = false;
  getTracerSpy = vi.spyOn(trace, 'getTracer').mockImplementation(
    () =>
      ({
        startSpan: (name: string, options?: { attributes?: Attributes }) => {
          if (startSpanThrows) throw new Error('otel provider fault');
          spans.push({ name, attributes: options?.attributes });
          return { end: () => undefined };
        },
      }) as unknown as Tracer,
  );
});

afterEach(() => {
  getTracerSpy.mockRestore();
});

describe('renderer language telemetry', () => {
  test('records the change under ok.language.preferenceChanged', () => {
    recordLanguagePreferenceChanged({ from: 'system', to: 'es' });
    expect(spans).toEqual([
      {
        name: 'ok.language.preferenceChanged',
        attributes: { 'ok.language.from': 'system', 'ok.language.to': 'es' },
      },
    ]);
  });

  test('carries the chosen locale, not just the fact of a change', () => {
    recordLanguagePreferenceChanged({ from: 'en', to: 'zh-Hans' });
    expect(spans[0]?.attributes).toEqual({
      'ok.language.from': 'en',
      'ok.language.to': 'zh-Hans',
    });
  });

  test('reports a switch back to system unresolved', () => {
    recordLanguagePreferenceChanged({ from: 'fr', to: 'system' });
    expect(spans[0]?.attributes).toEqual({
      'ok.language.from': 'fr',
      'ok.language.to': 'system',
    });
  });
});

describe('renderer language telemetry — SDK fault isolation', () => {
  test('a startSpan throw does not escape the emitter', () => {
    startSpanThrows = true;
    expect(() => recordLanguagePreferenceChanged({ from: 'system', to: 'ar' })).not.toThrow();
  });
});
