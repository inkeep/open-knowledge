import { describe, expect, test } from 'vitest';
import {
  attachLifecycleLogging,
  type LifecycleLoggingProcess,
  type LifecycleLoggingStdin,
  type LifecycleLoggingTransport,
} from './lifecycle-logging.ts';

type ProcessEvent = 'exit' | 'uncaughtExceptionMonitor';
type StdinEvent = 'end' | 'close';

interface HarnessOptions {
  log?: (msg: string) => void;
}

function createHarness(opts: HarnessOptions = {}) {
  const logs: string[] = [];
  const transport: LifecycleLoggingTransport = {};
  const processListeners: Map<ProcessEvent, (...args: unknown[]) => void> = new Map();
  const stdinListeners: Map<StdinEvent, () => void> = new Map();
  const fakeProcess: LifecycleLoggingProcess = {
    on(event: ProcessEvent, listener: (...args: unknown[]) => void) {
      processListeners.set(event, listener);
      return fakeProcess;
    },
  };
  const fakeStdin: LifecycleLoggingStdin = {
    once(event: StdinEvent, listener: () => void) {
      stdinListeners.set(event, listener);
      return fakeStdin;
    },
  };
  attachLifecycleLogging({
    log: opts.log ?? ((m) => logs.push(m)),
    transport,
    process: fakeProcess,
    stdin: fakeStdin,
  });
  return { logs, transport, processListeners, stdinListeners };
}

describe('attachLifecycleLogging — transport.onclose', () => {
  test('emits the internal-shutdown line (the only path that reaches onclose today)', () => {
    const { logs, transport } = createHarness();
    transport.onclose?.();
    expect(logs).toEqual(['[mcp] stdio transport closed (internal shutdown)']);
  });

  test('composes with a pre-existing onclose handler instead of replacing it', () => {
    const transport: LifecycleLoggingTransport = {};
    const order: string[] = [];
    transport.onclose = () => order.push('prev');
    const logs: string[] = [];
    attachLifecycleLogging({
      log: (m) => {
        logs.push(m);
        order.push('logged');
      },
      transport,
      process: { on: () => undefined },
      stdin: { once: () => undefined },
    });
    transport.onclose?.();
    expect(order).toEqual(['logged', 'prev']);
    expect(logs).toEqual(['[mcp] stdio transport closed (internal shutdown)']);
  });

  test('a throwing log() does not break composition with prevOnClose', () => {
    const transport: LifecycleLoggingTransport = {};
    let prevCalled = false;
    transport.onclose = () => {
      prevCalled = true;
    };
    attachLifecycleLogging({
      log: () => {
        throw new Error('log sink dead');
      },
      transport,
      process: { on: () => undefined },
      stdin: { once: () => undefined },
    });
    expect(() => transport.onclose?.()).not.toThrow();
    expect(prevCalled).toBe(true);
  });
});

describe('attachLifecycleLogging — stdin events (host-disconnect signal)', () => {
  test('emits on stdin "end" — the actual host-closed-pipe signal', () => {
    const { logs, stdinListeners } = createHarness();
    stdinListeners.get('end')?.();
    expect(logs).toEqual(['[mcp] stdin EOF (host closed pipe)']);
  });

  test('emits on stdin "close"', () => {
    const { logs, stdinListeners } = createHarness();
    stdinListeners.get('close')?.();
    expect(logs).toEqual(['[mcp] stdin closed']);
  });
});

describe('attachLifecycleLogging — process.on(exit)', () => {
  test('emits the exit code', () => {
    const { logs, processListeners } = createHarness();
    processListeners.get('exit')?.(0);
    expect(logs).toEqual(['[mcp] exit code=0']);
  });

  test('handles non-zero exit codes', () => {
    const { logs, processListeners } = createHarness();
    processListeners.get('exit')?.(1);
    expect(logs).toEqual(['[mcp] exit code=1']);
  });

  test('a throwing log() does not propagate out of the exit listener', () => {
    const { processListeners } = createHarness({
      log: () => {
        throw new Error('log sink dead');
      },
    });
    expect(() => processListeners.get('exit')?.(0)).not.toThrow();
  });
});

describe('attachLifecycleLogging — uncaughtExceptionMonitor', () => {
  test('includes origin and the error stack when present', () => {
    const { logs, processListeners } = createHarness();
    const err = new Error('boom');
    processListeners.get('uncaughtExceptionMonitor')?.(err, 'uncaughtException');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[mcp] uncaughtException origin=uncaughtException:');
    expect(logs[0]).toContain('Error: boom');
  });

  test('falls back to error message when stack is missing', () => {
    const { logs, processListeners } = createHarness();
    const err = new Error('no stack here');
    err.stack = undefined;
    processListeners.get('uncaughtExceptionMonitor')?.(err, 'unhandledRejection');
    expect(logs[0]).toBe('[mcp] uncaughtException origin=unhandledRejection: no stack here');
  });

  test('coerces a non-Error throwable to a string', () => {
    const { logs, processListeners } = createHarness();
    processListeners.get('uncaughtExceptionMonitor')?.('string-throw', 'uncaughtException');
    expect(logs[0]).toBe('[mcp] uncaughtException origin=uncaughtException: string-throw');
  });

  test('a throwing log() does not propagate (preserves the observe-only contract)', () => {
    const { processListeners } = createHarness({
      log: () => {
        throw new Error('log sink dead');
      },
    });
    expect(() =>
      processListeners.get('uncaughtExceptionMonitor')?.(new Error('boom'), 'uncaughtException'),
    ).not.toThrow();
  });
});
