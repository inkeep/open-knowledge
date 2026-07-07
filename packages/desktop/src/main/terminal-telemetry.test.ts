/**
 * Terminal lifecycle telemetry (main half) — assert each emitter wraps
 * `withSpanSync` with the canonical span name + bounded-cardinality attribute
 * shape, and that no command contents / paths can reach a span. `withSpanSync`
 * is mocked at the module boundary so the assertions hold regardless of whether
 * the OTel SDK is enabled. The subject mirrors the `onboarding-telemetry.ts`
 * emitter pattern (same `withSpanSync` + bounded-attribute discipline).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

interface CapturedSpanCall {
  name: string;
  options: { attributes?: Record<string, unknown> } | undefined;
}

const capturedCalls: CapturedSpanCall[] = [];

mock.module('@inkeep/open-knowledge-server', () => ({
  withSpanSync: <T>(
    name: string,
    options: { attributes?: Record<string, unknown> } | undefined,
    fn: () => T,
  ): T => {
    capturedCalls.push({ name, options });
    return fn();
  },
}));

const {
  recordConcurrentSessions,
  recordShellExit,
  recordTerminalSession,
  recordTerminalWindowOpened,
} = await import('../../src/main/terminal-telemetry.ts');

describe('recordShellExit — span name + crashed attribute', () => {
  beforeEach(() => {
    capturedCalls.length = 0;
  });

  test('a clean exit emits ok.desktop.shellExit with shell_crashed=false', () => {
    recordShellExit({ crashed: false });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.name).toBe('ok.desktop.shellExit');
    expect(capturedCalls[0]?.options?.attributes).toEqual({ 'ok.desktop.shell_crashed': false });
  });

  test('a crash emits ok.desktop.shellExit with shell_crashed=true', () => {
    recordShellExit({ crashed: true });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.options?.attributes).toEqual({ 'ok.desktop.shell_crashed': true });
  });

  test('the only attribute is the bounded crashed boolean — no path / code / signal leaks', () => {
    recordShellExit({ crashed: true });
    const attrs = capturedCalls[0]?.options?.attributes ?? {};
    expect(Object.keys(attrs)).toEqual(['ok.desktop.shell_crashed']);
  });
});

describe('recordTerminalSession — count-only marker', () => {
  beforeEach(() => {
    capturedCalls.length = 0;
  });

  test('emits ok.desktop.terminalSession with no attributes (the span is the count)', () => {
    recordTerminalSession();
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.name).toBe('ok.desktop.terminalSession');
    expect(capturedCalls[0]?.options?.attributes ?? {}).toEqual({});
  });
});

describe('recordConcurrentSessions — count-only concurrency signal', () => {
  beforeEach(() => {
    capturedCalls.length = 0;
  });

  test('emits ok.desktop.terminalConcurrentSessions carrying the live session count', () => {
    recordConcurrentSessions({ count: 3 });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.name).toBe('ok.desktop.terminalConcurrentSessions');
    expect(capturedCalls[0]?.options?.attributes).toEqual({ 'ok.desktop.concurrent_sessions': 3 });
  });

  test('the only attribute is the bounded count — no ptyId / path / command content leaks', () => {
    recordConcurrentSessions({ count: 2 });
    const attrs = capturedCalls[0]?.options?.attributes ?? {};
    expect(Object.keys(attrs)).toEqual(['ok.desktop.concurrent_sessions']);
  });
});

describe('recordTerminalWindowOpened — count-only adoption marker', () => {
  beforeEach(() => {
    capturedCalls.length = 0;
  });

  test('emits ok.desktop.terminalWindowOpened with no attributes (the span is the count)', () => {
    recordTerminalWindowOpened();
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.name).toBe('ok.desktop.terminalWindowOpened');
    expect(capturedCalls[0]?.options?.attributes ?? {}).toEqual({});
  });
});
