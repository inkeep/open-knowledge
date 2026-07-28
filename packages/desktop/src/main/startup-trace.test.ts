import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  __resetStartupTraceForTest,
  beginRoot,
  childSpan,
  endRoot,
  injectTraceparent,
  isStartupTraceActive,
} from './startup-trace.ts';

const prevDisabled = process.env.OTEL_SDK_DISABLED;

beforeEach(() => {
  __resetStartupTraceForTest();
});

afterEach(() => {
  __resetStartupTraceForTest();
  endRoot();
  if (prevDisabled === undefined) delete process.env.OTEL_SDK_DISABLED;
  else process.env.OTEL_SDK_DISABLED = prevDisabled;
});

describe('startup-trace (Plan A) — disabled path', () => {
  test('beginRoot is a no-op when OTEL_SDK_DISABLED is not "false"', () => {
    delete process.env.OTEL_SDK_DISABLED;
    expect(beginRoot()).toBe(false);
    expect(isStartupTraceActive()).toBe(false);
  });

  test('beginRoot is a no-op when OTEL_SDK_DISABLED === "true"', () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    expect(beginRoot()).toBe(false);
    expect(isStartupTraceActive()).toBe(false);
  });

  test('injectTraceparent returns undefined when not active', () => {
    delete process.env.OTEL_SDK_DISABLED;
    beginRoot();
    expect(injectTraceparent()).toBeUndefined();
  });

  test('childSpan + endRoot are safe no-ops when not active', () => {
    delete process.env.OTEL_SDK_DISABLED;
    expect(() => {
      childSpan('phase', { ok: true }, 0, 1);
      endRoot();
    }).not.toThrow();
  });
});
