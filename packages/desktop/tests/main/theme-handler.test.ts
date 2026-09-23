import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const desktopLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const getLogger = vi.hoisted(() => vi.fn(() => desktopLog));
vi.mock('../../src/main/desktop-logger.ts', () => ({ getLogger }));

import {
  applyThemeSource,
  emitThemeSourceRecord,
  isOkThemeSource,
  type ThemeSourceRecord,
} from '../../src/main/theme-handler.ts';
import type { OkThemeSource } from '../../src/shared/bridge-contract.ts';
import {
  APPLIED_RECORD,
  REJECTED_RECORD_WITH_UNSERIALIZABLE_PAYLOAD,
} from './theme-source-records.test-helper.ts';

interface TraceEvent {
  step: 'getThemeSource' | 'setThemeSource' | 'emit';
  args?: unknown;
}

function makeDeps(initialThemeSource: OkThemeSource = 'system') {
  let current: OkThemeSource = initialThemeSource;
  const trace: TraceEvent[] = [];
  return {
    trace,
    getCurrent: () => current,
    emitted: () =>
      trace.filter((t) => t.step === 'emit').map((t) => t.args as Record<string, unknown>),
    deps: {
      getThemeSource: () => {
        trace.push({ step: 'getThemeSource' });
        return current;
      },
      setThemeSource: (source: OkThemeSource) => {
        trace.push({ step: 'setThemeSource', args: { source } });
        current = source;
      },
      emit: (record: ThemeSourceRecord) => {
        trace.push({ step: 'emit', args: record });
      },
    },
  };
}

describe('applyThemeSource happy path', () => {
  test('flips nativeTheme.themeSource from system to dark', () => {
    const { deps, getCurrent } = makeDeps('system');
    const result = applyThemeSource(deps, 'dark', 3);
    expect(result).toEqual({ ok: true });
    expect(getCurrent()).toBe('dark');
  });

  test('emits a structured record with prevSource and trigger=ipc', () => {
    const { deps, emitted } = makeDeps('light');
    applyThemeSource(deps, 'dark', 7);
    expect(emitted()).toEqual([
      {
        event: 'theme-source-set',
        source: 'dark',
        prevSource: 'light',
        trigger: 'ipc',
        senderWindowId: 7,
      },
    ]);
  });

  test.each([['system' as OkThemeSource], ['light' as OkThemeSource], ['dark' as OkThemeSource]])(
    'accepts each user-intent value: %s',
    (source) => {
      const { deps, getCurrent } = makeDeps('system');
      const result = applyThemeSource(deps, source, 1);
      expect(result).toEqual({ ok: true });
      expect(getCurrent()).toBe(source);
    },
  );
});

describe('applyThemeSource defensive rejection', () => {
  test('does not call setThemeSource for an out-of-range value', () => {
    const { deps, trace, getCurrent } = makeDeps('system');
    const result = applyThemeSource(deps, 'auto' as unknown as OkThemeSource, 1);
    expect(result).toEqual({ ok: true });
    expect(getCurrent()).toBe('system');
    expect(trace.find((t) => t.step === 'setThemeSource')).toBeUndefined();
  });

  test('emits a structured record with reason=invalid-source on rejection', () => {
    const { deps, emitted } = makeDeps('system');
    applyThemeSource(deps, 'rainbow' as unknown as OkThemeSource, 4);
    expect(emitted()).toEqual([
      {
        event: 'theme-source-set-rejected',
        received: 'rainbow',
        reason: 'invalid-source',
        senderWindowId: 4,
      },
    ]);
  });
});

describe('applyThemeSource sender attribution', () => {
  test('records a null senderWindowId when the sender has no window', () => {
    const { deps, emitted } = makeDeps('system');
    applyThemeSource(deps, 'light', null);
    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]?.senderWindowId).toBeNull();
  });

  test('distinguishes two windows pushing the same source', () => {
    const { deps, emitted } = makeDeps('system');
    applyThemeSource(deps, 'system', 1);
    applyThemeSource(deps, 'system', 2);
    expect(emitted().map((record) => record.senderWindowId)).toEqual([1, 2]);
  });
});

describe('applyThemeSource side-effect boundaries', () => {
  test('does not require setBackgroundColor or saveAppState — those deps are absent', () => {
    const { deps } = makeDeps('system');
    const depKeys = new Set(Object.keys(deps));
    expect(depKeys).toEqual(new Set(['getThemeSource', 'setThemeSource', 'emit']));
  });
});

describe('emitThemeSourceRecord dual sink', () => {
  const consoleWarnCalls: unknown[][] = [];
  let restoreConsoleWarn = () => {};

  beforeEach(() => {
    consoleWarnCalls.length = 0;
    getLogger.mockClear();
    desktopLog.info.mockClear();
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      consoleWarnCalls.push(args);
    });
    restoreConsoleWarn = () => {
      spy.mockRestore();
    };
  });

  afterEach(() => {
    restoreConsoleWarn();
  });

  function soleConsoleLine(): string {
    expect(consoleWarnCalls).toHaveLength(1);
    const args = consoleWarnCalls[0] ?? [];
    expect(args).toHaveLength(1);
    const [line] = args;
    expect(typeof line).toBe('string');
    return String(line);
  }

  function soleDurableRecord(): Record<string, unknown> {
    expect(desktopLog.info).toHaveBeenCalledTimes(1);
    const [data] = desktopLog.info.mock.calls[0] ?? [];
    expect(data).toBeTypeOf('object');
    return data;
  }

  test('writes the whole record to the console sink as one JSON line', () => {
    emitThemeSourceRecord(APPLIED_RECORD);
    expect(JSON.parse(soleConsoleLine())).toEqual(APPLIED_RECORD);
  });

  test('writes the whole record to the durable theme log under the event as message', () => {
    emitThemeSourceRecord(APPLIED_RECORD);
    expect(getLogger).toHaveBeenCalledWith('theme');
    expect(desktopLog.info).toHaveBeenCalledTimes(1);
    expect(desktopLog.info.mock.calls[0]?.[0]).toEqual(APPLIED_RECORD);
    expect(desktopLog.info.mock.calls[0]?.[1]).toBe('theme-source-set');
  });

  test('leaves rejection-only fields off an applied record in the durable sink', () => {
    emitThemeSourceRecord(APPLIED_RECORD);
    const durable = soleDurableRecord();
    expect(Object.keys(durable)).toContain('event');
    expect(durable).not.toHaveProperty('receivedKind');
    expect(durable).not.toHaveProperty('receivedSample');
  });

  test('keeps a rejected payload out of the durable sink', () => {
    emitThemeSourceRecord({
      event: 'theme-source-set-rejected',
      received: { auth: { token: 'SHOULD-NOT-APPEAR' } },
      reason: 'invalid-source',
      senderWindowId: 2,
    });
    const durable = soleDurableRecord();
    expect(JSON.stringify(durable)).not.toContain('SHOULD-NOT-APPEAR');
    expect(durable).not.toHaveProperty('received');
    expect(durable.receivedKind).toBe('object');
  });

  test('classifies a rejected array as an array, not a bare object', () => {
    emitThemeSourceRecord({
      event: 'theme-source-set-rejected',
      received: ['dark', { auth: { token: 'SHOULD-NOT-APPEAR' } }],
      reason: 'invalid-source',
      senderWindowId: 3,
    });
    const durable = soleDurableRecord();
    expect(durable.receivedKind).toBe('array');
    expect(JSON.stringify(durable)).not.toContain('SHOULD-NOT-APPEAR');
    expect(durable).not.toHaveProperty('received');
  });

  test('bounds a long rejected string in the durable sink', () => {
    emitThemeSourceRecord({
      event: 'theme-source-set-rejected',
      received: 'x'.repeat(5000),
      reason: 'invalid-source',
      senderWindowId: 2,
    });
    const durable = soleDurableRecord();
    expect(durable.receivedSample).toBeTypeOf('string');
    expect(durable.receivedSample).toHaveLength(64);
  });

  test('writes the unbounded rejected payload to the console sink', () => {
    emitThemeSourceRecord({
      event: 'theme-source-set-rejected',
      received: { auth: { token: 'X' } },
      reason: 'invalid-source',
      senderWindowId: 5,
    });
    expect(JSON.parse(soleConsoleLine())).toEqual({
      event: 'theme-source-set-rejected',
      received: { auth: { token: 'X' } },
      reason: 'invalid-source',
      senderWindowId: 5,
    });
  });

  test('keeps the durable sink reachable when a rejected payload cannot be serialized', () => {
    expect(() => emitThemeSourceRecord(REJECTED_RECORD_WITH_UNSERIALIZABLE_PAYLOAD)).not.toThrow();

    const degraded = {
      event: 'theme-source-set-rejected',
      reason: 'invalid-source',
      senderWindowId: 4,
      receivedKind: 'bigint',
      receivedSample: null,
    };
    expect(soleDurableRecord()).toEqual(degraded);
    expect(desktopLog.info.mock.calls[0]?.[1]).toBe('theme-source-set-rejected');
    expect(JSON.parse(soleConsoleLine())).toEqual(degraded);
  });
});

describe('isOkThemeSource type predicate', () => {
  test.each([['system'], ['light'], ['dark']])(
    'accepts canonical OkThemeSource value: %s',
    (value) => {
      expect(isOkThemeSource(value)).toBe(true);
    },
  );

  test.each([['auto'], ['Light'], [''], ['SYSTEM'], ['system ']])(
    'rejects out-of-range string: %s',
    (value) => {
      expect(isOkThemeSource(value)).toBe(false);
    },
  );

  test.each([[null], [undefined], [42], [true], [{}], [['system']]])(
    'rejects non-string input: %p',
    (value) => {
      expect(isOkThemeSource(value)).toBe(false);
    },
  );
});
