import { describe, expect, test } from 'vitest';
import {
  attachRendererConsoleCapture,
  type ConsoleCapturingWebContents,
} from './renderer-console-capture.ts';

interface FakeEvent {
  message: string;
  level: string;
  lineNumber?: number;
  sourceId?: string;
}

function makeFakeWebContents(): ConsoleCapturingWebContents & { emit(e: FakeEvent): void } {
  let handler: ((event: FakeEvent) => void) | null = null;
  return {
    on(_event, listener) {
      handler = listener as (event: FakeEvent) => void;
    },
    emit(e) {
      handler?.(e);
    },
  };
}

interface LogCall {
  level: 'info' | 'warn' | 'error';
  data: Record<string, unknown>;
  msg: string;
}

function makeSpyLogger() {
  const calls: LogCall[] = [];
  const record = (level: LogCall['level']) => (data: Record<string, unknown>, msg: string) =>
    calls.push({ level, data, msg });
  return {
    calls,
    getLogger: () => ({ info: record('info'), warn: record('warn'), error: record('error') }),
  };
}

describe('attachRendererConsoleCapture', () => {
  test('maps console levels to pino levels (warning -> warn)', () => {
    const wc = makeFakeWebContents();
    const spy = makeSpyLogger();
    attachRendererConsoleCapture(wc, { getLogger: spy.getLogger });

    wc.emit({ level: 'error', message: 'boom' });
    wc.emit({ level: 'warning', message: 'careful' });
    wc.emit({ level: 'info', message: 'fyi' });

    expect(spy.calls.map((c) => c.level)).toEqual(['error', 'warn', 'info']);
  });

  test('drops debug/verbose (no log call)', () => {
    const wc = makeFakeWebContents();
    const spy = makeSpyLogger();
    attachRendererConsoleCapture(wc, { getLogger: spy.getLogger });

    wc.emit({ level: 'debug', message: 'noisy' });
    wc.emit({ level: 'verbose', message: 'noisier' });

    expect(spy.calls).toHaveLength(0);
  });

  test('lifts a structured JSON message into event + fields', () => {
    const wc = makeFakeWebContents();
    const spy = makeSpyLogger();
    attachRendererConsoleCapture(wc, { getLogger: spy.getLogger });

    wc.emit({
      level: 'warning',
      message: JSON.stringify({
        event: 'ok-provider-server-driven-close-reauth',
        docName: 'notes',
        reason: 'Failed to connect',
      }),
      sourceId: 'app.js',
      lineNumber: 12,
    });

    expect(spy.calls).toHaveLength(1);
    const call = spy.calls[0];
    if (!call) throw new Error('expected exactly one log call');
    expect(call.level).toBe('warn');
    expect(call.msg).toBe('ok-provider-server-driven-close-reauth');
    expect(call.data.reason).toBe('Failed to connect');
    expect(call.data.docName).toBe('notes');
    expect(call.data.source).toBe('renderer-console');
    expect(call.data.transport).toBe('electron');
    expect(call.data.sourceId).toBe('app.js');
    expect(call.data.lineNumber).toBe(12);
  });

  test('renderer fields cannot clobber the provenance markers', () => {
    const wc = makeFakeWebContents();
    const spy = makeSpyLogger();
    attachRendererConsoleCapture(wc, { getLogger: spy.getLogger });
    wc.emit({
      level: 'error',
      message: JSON.stringify({
        event: 'evt',
        source: 'spoofed',
        transport: 'spoofed',
        sourceId: 'spoofed',
        lineNumber: 9999,
      }),
      sourceId: 'real.js',
      lineNumber: 7,
    });
    const call = spy.calls[0];
    if (!call) throw new Error('expected exactly one log call');
    expect(call.data.source).toBe('renderer-console');
    expect(call.data.transport).toBe('electron');
    expect(call.data.sourceId).toBe('real.js');
    expect(call.data.lineNumber).toBe(7);
  });

  test('logs a plain string message as the body', () => {
    const wc = makeFakeWebContents();
    const spy = makeSpyLogger();
    attachRendererConsoleCapture(wc, { getLogger: spy.getLogger });

    wc.emit({ level: 'info', message: 'just a string' });

    expect(spy.calls[0]?.msg).toBe('just a string');
  });

  test('a throwing logger never propagates out of the listener', () => {
    const wc = makeFakeWebContents();
    attachRendererConsoleCapture(wc, {
      getLogger: () => {
        throw new Error('logger boom');
      },
    });
    expect(() => wc.emit({ level: 'error', message: 'x' })).not.toThrow();
  });
});
