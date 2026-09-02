import { beforeEach, describe, expect, test, vi } from 'vitest';

interface CapturedSpanCall {
  name: string;
  options: { attributes?: Record<string, unknown> } | undefined;
}

const capturedCalls: CapturedSpanCall[] = [];

vi.doMock('@inkeep/open-knowledge-server', () => ({
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
    expect(capturedCalls[0]?.options?.attributes).toEqual({
      'ok.desktop.shell_crashed': false,
      'ok.platform': process.platform,
    });
  });

  test('a crash emits ok.desktop.shellExit with shell_crashed=true', () => {
    recordShellExit({ crashed: true });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.options?.attributes).toEqual({
      'ok.desktop.shell_crashed': true,
      'ok.platform': process.platform,
    });
  });

  test('attributes stay bounded — no path / code / signal leaks', () => {
    recordShellExit({ crashed: true });
    const attrs = capturedCalls[0]?.options?.attributes ?? {};
    expect(Object.keys(attrs)).toEqual(['ok.desktop.shell_crashed', 'ok.platform']);
  });
});

describe('recordTerminalSession — count-only marker', () => {
  beforeEach(() => {
    capturedCalls.length = 0;
  });

  test('emits ok.desktop.terminalSession with only the bounded platform attribute', () => {
    recordTerminalSession();
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.name).toBe('ok.desktop.terminalSession');
    expect(capturedCalls[0]?.options?.attributes).toEqual({ 'ok.platform': process.platform });
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
    expect(capturedCalls[0]?.options?.attributes).toEqual({
      'ok.desktop.concurrent_sessions': 3,
      'ok.platform': process.platform,
    });
  });

  test('attributes stay bounded — no ptyId / path / command content leaks', () => {
    recordConcurrentSessions({ count: 2 });
    const attrs = capturedCalls[0]?.options?.attributes ?? {};
    expect(Object.keys(attrs)).toEqual(['ok.desktop.concurrent_sessions', 'ok.platform']);
  });
});

describe('recordTerminalWindowOpened — count-only adoption marker', () => {
  beforeEach(() => {
    capturedCalls.length = 0;
  });

  test('emits ok.desktop.terminalWindowOpened with only the bounded platform attribute', () => {
    recordTerminalWindowOpened();
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.name).toBe('ok.desktop.terminalWindowOpened');
    expect(capturedCalls[0]?.options?.attributes).toEqual({ 'ok.platform': process.platform });
  });
});
